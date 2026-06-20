"""探空气球运动方程。

气球飞行分为三个阶段：
1. **上升阶段**：浮力大于重力，以标称净升速上升；水平随气流平流。
2. **爆裂**：达到预设爆裂高度（典型 20~35 km）后，球膜破裂，载荷开始自由下落。
3. **下降阶段**：降落伞打开，载荷以终端速度下落；水平仍受风场作用。

水平运动完全由风场平流主导（忽略气球惯性）：
    dlat/dt = (v_wind / R) · (1 / cosφ)
    dlon/dt = (u_wind / R)
其中 φ 为当前纬度，R 为地球半径。

垂直速度受气球规格和降落伞阻力决定，可由升速/降速参数化，
避免引入复杂的流体阻力模型以保持工程简洁。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from modules.trajectory.wind_profile import WindProfile
from modules.pressure_calc import constants as C


@dataclass
class BalloonSpec:
    """气球规格参数。

    属性:
        ascent_rate_mps: 标称净上升速率，典型 4~6 m/s。
        burst_altitude_m: 爆裂高度，典型 25000~35000 m。
        descent_rate_mps: 开伞后终端下降速率，典型 5~8 m/s(正值表示向下速率)。
    """
    ascent_rate_mps: float = 5.0
    burst_altitude_m: float = 30000.0
    descent_rate_mps: float = 6.0


@dataclass
class FlightState:
    """某一时刻的飞行状态。

    位置用(lat°, lon°, alt_m)球面坐标，时间用相对秒(秒表)。
    phase 取值: "ascent" | "burst" | "descent" | "landed"
    """
    t_sec: float
    lat: float
    lon: float
    alt: float
    phase: str
    wind_u: float
    wind_v: float


def derivatives(state: FlightState, profile: WindProfile, spec: BalloonSpec) -> tuple[float, float, float]:
    """状态导数 (dlat/dt, dlon/dt, dh/dt)。

    水平平流按球面几何；垂直速度由阶段决定。
    """
    u, v = profile.at(state.alt)
    cos_lat = math.cos(math.radians(state.lat))
    if abs(cos_lat) < 1e-12:
        cos_lat = math.copysign(1e-12, cos_lat)

    dlat_dt = v / (C.EARTH_RADIUS * math.pi / 180.0)
    dlon_dt = u / (C.EARTH_RADIUS * math.pi / 180.0 * cos_lat)

    if state.phase == "ascent":
        dh_dt = spec.ascent_rate_mps
        if state.alt >= spec.burst_altitude_m:
            dh_dt = 0.0
    elif state.phase == "descent":
        dh_dt = -spec.descent_rate_mps
    else:
        dh_dt = 0.0

    return dlat_dt, dlon_dt, dh_dt


def transition_phase(state: FlightState, spec: BalloonSpec) -> str:
    """根据当前高度和阶段判断下一个阶段。"""
    if state.phase == "ascent" and state.alt >= spec.burst_altitude_m:
        return "burst"
    if state.phase == "burst":
        return "descent"
    if state.phase == "descent" and state.alt <= 0.0:
        return "landed"
    return state.phase
