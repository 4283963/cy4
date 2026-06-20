"""气球业务服务层：封装反演、推演，并生成演示用样本数据。

服务维护一个轻量的内存字典来注册已知气球，便于前端按 id 查询。
样本数据生成器使用与反演对称的正向物理过程（标准大气压高公式 + 风场平流）
加高斯噪声，使得演示数据的反演与推演结果具有物理一致性。
"""
from __future__ import annotations

import math
import random
import uuid
from typing import Any

import numpy as np

from models.schemas import (
    AtmosphereState,
    BalloonReading,
    LandingPoint,
    PredictRequest,
    TrajectoryPoint,
    WindVector,
)
from modules.pressure_calc import PressureCalculator
from modules.pressure_calc import atmosphere as atm
from modules.trajectory import TrajectoryPredictor
from modules.trajectory.physics import BalloonSpec
from modules.trajectory.wind_profile import WindProfile

_calc = PressureCalculator()
_predictor = TrajectoryPredictor()
_balloon_store: dict[str, dict] = {}


def _convert_state(raw: dict) -> AtmosphereState:
    return AtmosphereState(
        timestamp=raw["timestamp"],
        altitude_m=raw["altitude_m"],
        pressure_hpa=raw["pressure_hpa"],
        temperature_c=raw["temperature_c"],
        temperature_k=raw["temperature_k"],
        density_kg_m3=raw["density_kg_m3"],
        sound_speed_mps=raw["sound_speed_mps"],
        ascent_rate_mps=raw["ascent_rate_mps"],
        wind=WindVector(
            u_mps=raw["wind_u_mps"],
            v_mps=raw["wind_v_mps"],
            speed_mps=raw["wind_speed_mps"],
            direction_deg=raw["wind_direction_deg"],
        ),
        lat=raw.get("lat"),
        lon=raw.get("lon"),
    )


def register_balloon(balloon_id: str, initial: dict) -> str:
    bid = balloon_id or uuid.uuid4().hex[:8]
    _balloon_store[bid] = {"id": bid, "initial": initial, "readings": []}
    return bid


def add_readings(balloon_id: str, readings: list[BalloonReading]) -> int:
    if balloon_id not in _balloon_store:
        _balloon_store[balloon_id] = {"id": balloon_id, "initial": {}, "readings": []}
    recs = [r.model_dump() for r in readings]
    _balloon_store[balloon_id]["readings"].extend(recs)
    return len(recs)


def compute_states(balloon_id: str, readings: list[BalloonReading] | None = None) -> tuple[str, list[AtmosphereState]]:
    """对指定气球执行气压反演。

    若未传 readings，则使用已注册的历史读数。
    """
    if readings is not None:
        recs = [r.model_dump() for r in readings]
    else:
        recs = _balloon_store.get(balloon_id, {}).get("readings", [])
    raw_states = _calc.compute(recs)
    states = [_convert_state(s) for s in raw_states]
    return balloon_id, states


def predict_trajectory(req: PredictRequest) -> tuple[list[TrajectoryPoint], LandingPoint, list[AtmosphereState]]:
    """执行轨迹推演。若 request 中带有 readings 则先反演得到风廓线。

    返回 (trajectory_points, landing_point, atm_states_used) 三元组。
    前端可直接使用 atm_states_used 作为历史段展示。
    """
    states: list[AtmosphereState] = []
    if req.readings is not None and len(req.readings) > 0:
        _, states = compute_states(req.balloon_id, req.readings)

    if req.wind_profile is not None and len(req.wind_profile) > 0:
        alts = [float(w["alt"]) for w in req.wind_profile]
        us = [float(w["u"]) for w in req.wind_profile]
        vs = [float(w["v"]) for w in req.wind_profile]
        profile = WindProfile(alts, us, vs)
    elif len(states) > 0:
        alts = [s.altitude_m for s in states if s.lat is not None]
        us = [s.wind.u_mps for s in states if s.lat is not None]
        vs = [s.wind.v_mps for s in states if s.lat is not None]
        if len(alts) >= 1:
            profile = WindProfile(alts, us, vs)
        else:
            profile = _default_wind_profile()
    else:
        profile = _default_wind_profile()

    spec = BalloonSpec()
    if req.balloon_spec is not None:
        spec = BalloonSpec(**{k: v for k, v in req.balloon_spec.items()
                              if k in BalloonSpec.__annotations__})

    initial: dict[str, Any] = {
        "lat": req.initial_lat,
        "lon": req.initial_lon,
        "alt": req.initial_alt,
        "phase": req.initial_phase,
    }
    raw_traj, raw_landing = _predictor.predict(
        initial=initial,
        wind_profile=profile,
        spec=spec,
        dt_sec=req.dt_sec,
        max_steps=req.max_steps,
    )
    traj = [TrajectoryPoint(**pt) for pt in raw_traj]
    landing = LandingPoint(**raw_landing)
    return traj, landing, states


def _default_wind_profile() -> WindProfile:
    """未提供风场时的默认中纬度风廓线，确保演示始终有可见轨迹。"""
    alts = np.array([0, 2000, 5000, 10000, 15000, 20000, 25000, 32000], dtype=float)
    # 中纬度典型西风随高度增强并在对流层顶达到峰值
    us = np.array([3.0, 6.0, 12.0, 25.0, 40.0, 55.0, 45.0, 30.0], dtype=float)
    vs = np.array([0.0, -1.0, -2.0, -3.0, -2.0, 1.0, 3.0, 2.0], dtype=float)
    return WindProfile(alts, us, vs)


# ---------------------------------------------------------------------------
# 样本数据生成器：正向物理模拟 + 测量噪声，生成闭环可验证的演示数据
# ---------------------------------------------------------------------------

def generate_demo_readings(
    seed: int = 42,
    lat0: float = 39.9042,
    lon0: float = 116.4074,
    duration_sec: float = 7200.0,
    interval_sec: float = 15.0,
) -> tuple[str, list[BalloonReading], dict]:
    """生成一条逼真的探空气球飞行读数序列。

    飞行流程：以 5 m/s 上升，受真实风廓线平流，在 30 km 处爆裂，
    随后以 6 m/s 终端速度下降。每一步用 ISA 公式计算当前高度下的
    气压与温度，再叠加测量噪声。返回 (balloon_id, readings, meta)。
    """
    rng = random.Random(seed)
    np_rng = np.random.default_rng(seed)

    spec = BalloonSpec(ascent_rate_mps=5.0, burst_altitude_m=30000.0, descent_rate_mps=6.0)
    profile = _default_wind_profile()

    t = 0.0
    lat = lat0
    lon = lon0
    alt = 0.0
    phase = "ascent"
    readings: list[BalloonReading] = []
    bid = f"demo-{seed}"

    dt = interval_sec
    max_steps = int(math.ceil(duration_sec / dt))
    for _ in range(max_steps):
        u, v = profile.at(alt)

        # 用 ISA 公式计算当前高度对应的真实气压、温度
        p_pa_true = atm.pressure_at_altitude(alt)
        t_k_true = atm.temperature_at_altitude(alt)

        # 叠加测量噪声：气压 ±0.3 hPa，温度 ±0.2 K
        p_hpa = p_pa_true / 100.0 + np_rng.normal(0.0, 0.3)
        t_c = t_k_true - 273.15 + np_rng.normal(0.0, 0.2)

        # 经纬度有 5~15 m 随机抖动，模拟 GPS 噪声
        lat_noise = np_rng.normal(0.0, 1e-6)
        lon_noise = np_rng.normal(0.0, 1e-6)

        readings.append(BalloonReading(
            timestamp=t,
            pressure_hpa=float(p_hpa),
            temperature_c=float(t_c),
            lat=float(lat + lat_noise),
            lon=float(lon + lon_noise),
        ))

        # 步进位置（正向物理积分）
        cos_lat = math.cos(math.radians(lat))
        dlat = v / 6371000.0 * (180.0 / math.pi) * dt
        dlon = u / (6371000.0 * cos_lat) * (180.0 / math.pi) * dt
        lat += dlat
        lon += dlon

        if phase == "ascent":
            alt += spec.ascent_rate_mps * dt
            if alt >= spec.burst_altitude_m:
                alt = spec.burst_altitude_m
                phase = "descent"
        elif phase == "descent":
            alt -= spec.descent_rate_mps * dt
            if alt <= 0.0:
                break

        t += dt

        # 少量随机丢包，使数据"零散"
        if rng.random() < 0.08:
            t += dt

    meta = {
        "seed": seed,
        "launch_lat": lat0,
        "launch_lon": lon0,
        "duration_sec": t,
        "final_alt": max(0.0, alt),
        "final_lat": lat,
        "final_lon": lon,
        "spec": spec.__dict__,
    }
    return bid, readings, meta


def list_balloons() -> list[dict]:
    """返回所有已注册气球的概要信息。"""
    return [
        {
            "balloon_id": bid,
            "reading_count": len(data.get("readings", [])),
            "initial": data.get("initial", {}),
        }
        for bid, data in _balloon_store.items()
    ]
