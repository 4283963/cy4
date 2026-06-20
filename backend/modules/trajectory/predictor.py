"""轨迹推演预测器：RK4 数值积分，输出完整航迹与落点。

对当前时刻已知的气球状态，结合气压反演得到的风廓线，
向前推演气球从当前位置到落地的飞行轨迹。

数值方法采用 4 阶 Runge-Kutta (RK4)：
    k1 = f(t_n, y_n)
    k2 = f(t_n + dt/2, y_n + dt/2 * k1)
    k3 = f(t_n + dt/2, y_n + dt/2 * k2)
    k4 = f(t_n + dt, y_n + dt * k3)
    y_{n+1} = y_n + dt/6 * (k1 + 2k2 + 2k3 + k4)

对 dlat/dt, dlon/dt, dh/dt 三个分量分别执行 RK4，
状态空间为 (lat, lon, alt)。每次步进后检查阶段转换。
"""
from __future__ import annotations

import math
from typing import Sequence

from modules.trajectory.physics import (
    BalloonSpec,
    FlightState,
    derivatives,
    transition_phase,
)
from modules.trajectory.wind_profile import WindProfile


def _rk4_step(state: FlightState, dt: float, profile: WindProfile, spec: BalloonSpec) -> FlightState:
    """单步 RK4 积分，返回 dt 后的新状态。"""
    k1 = derivatives(state, profile, spec)
    s2 = FlightState(
        t_sec=state.t_sec + dt / 2,
        lat=state.lat + dt / 2 * k1[0],
        lon=state.lon + dt / 2 * k1[1],
        alt=state.alt + dt / 2 * k1[2],
        phase=state.phase, wind_u=0, wind_v=0,
    )
    k2 = derivatives(s2, profile, spec)
    s3 = FlightState(
        t_sec=state.t_sec + dt / 2,
        lat=state.lat + dt / 2 * k2[0],
        lon=state.lon + dt / 2 * k2[1],
        alt=state.alt + dt / 2 * k2[2],
        phase=state.phase, wind_u=0, wind_v=0,
    )
    k3 = derivatives(s3, profile, spec)
    s4 = FlightState(
        t_sec=state.t_sec + dt,
        lat=state.lat + dt * k3[0],
        lon=state.lon + dt * k3[1],
        alt=state.alt + dt * k3[2],
        phase=state.phase, wind_u=0, wind_v=0,
    )
    k4 = derivatives(s4, profile, spec)

    lat_new = state.lat + dt / 6.0 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
    lon_new = state.lon + dt / 6.0 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
    alt_new = state.alt + dt / 6.0 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])

    u_new, v_new = profile.at(alt_new)
    new_phase = transition_phase(
        FlightState(0, lat_new, lon_new, alt_new, state.phase, 0, 0), spec
    )
    if new_phase == "burst":
        # 爆裂瞬时发生，保持高度不变，直接进入下降阶段
        new_phase = "descent"
        alt_new = spec.burst_altitude_m

    return FlightState(
        t_sec=state.t_sec + dt,
        lat=float(lat_new),
        lon=float(lon_new),
        alt=float(alt_new),
        phase=new_phase,
        wind_u=float(u_new),
        wind_v=float(v_new),
    )


def _land_interpolate(a: FlightState, b: FlightState) -> FlightState:
    """当一步从正高度过到负高度时，线性插值使得落点高度精确为 0。"""
    if a.alt <= 0 or b.alt >= 0:
        return b
    frac = a.alt / (a.alt - b.alt)
    return FlightState(
        t_sec=a.t_sec + frac * (b.t_sec - a.t_sec),
        lat=a.lat + frac * (b.lat - a.lat),
        lon=a.lon + frac * (b.lon - a.lon),
        alt=0.0,
        phase="landed",
        wind_u=b.wind_u,
        wind_v=b.wind_v,
    )


class TrajectoryPredictor:
    """由初始状态与风廓线推演完整轨迹与落点。"""

    def predict(
        self,
        initial: dict,
        wind_profile: WindProfile,
        spec: BalloonSpec | None = None,
        dt_sec: float = 30.0,
        max_steps: int = 2000,
    ) -> tuple[list[dict], dict]:
        """向前推演轨迹，返回(轨迹点列表, 落点信息)。

        initial 字典键: lat, lon, alt, 可选 phase（默认 ascent）。
        轨迹点含: t_sec, lat, lon, alt, phase, wind_u, wind_v。
        落点含: lat, lon, alt=0, flight_time_sec。
        """
        spec = spec or BalloonSpec()
        init_phase = initial.get("phase", "ascent")
        if init_phase not in ("ascent", "burst", "descent"):
            init_phase = "ascent"
        u0, v0 = wind_profile.at(initial["alt"])
        state = FlightState(
            t_sec=0.0,
            lat=float(initial["lat"]),
            lon=float(initial["lon"]),
            alt=float(initial["alt"]),
            phase=init_phase,
            wind_u=float(u0),
            wind_v=float(v0),
        )

        trajectory: list[dict] = []
        trajectory.append({
            "t_sec": state.t_sec,
            "lat": state.lat,
            "lon": state.lon,
            "alt": state.alt,
            "phase": state.phase,
            "wind_u": state.wind_u,
            "wind_v": state.wind_v,
        })

        for _ in range(max_steps):
            next_state = _rk4_step(state, dt_sec, wind_profile, spec)

            if state.phase == "descent" and next_state.alt <= 0.0:
                landing = _land_interpolate(state, next_state)
                trajectory.append({
                    "t_sec": landing.t_sec,
                    "lat": landing.lat,
                    "lon": landing.lon,
                    "alt": landing.alt,
                    "phase": "landed",
                    "wind_u": landing.wind_u,
                    "wind_v": landing.wind_v,
                })
                landing_point = {
                    "lat": landing.lat,
                    "lon": landing.lon,
                    "alt": 0.0,
                    "flight_time_sec": landing.t_sec,
                }
                return trajectory, landing_point

            trajectory.append({
                "t_sec": next_state.t_sec,
                "lat": next_state.lat,
                "lon": next_state.lon,
                "alt": next_state.alt,
                "phase": next_state.phase,
                "wind_u": next_state.wind_u,
                "wind_v": next_state.wind_v,
            })
            state = next_state

            if state.phase == "landed":
                break

        landing_point = {
            "lat": state.lat,
            "lon": state.lon,
            "alt": max(0.0, state.alt),
            "flight_time_sec": state.t_sec,
        }
        return trajectory, landing_point
