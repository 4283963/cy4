"""标准大气模型：压高公式与空气状态参量。

采用分段国际标准大气(ISA)：
- 对流层(0~11km) 与递减率层使用正压公式
    P = P_b * (T_b / (T_b + L·dh))^(g / (R_d·L))
- 等温层使用指数公式
    P = P_b * exp(-g·dh / (R_d·T_b))

提供正向(高度->气压/温度)与反演(气压->高度)两种能力，
后者正是探空气球「由气压反推高度」的核心。
"""
from __future__ import annotations

import math

from modules.pressure_calc import constants as C


def _layer_index_for_altitude(h: float) -> int:
    layers = C.ISA_LAYERS
    for i in range(len(layers) - 1):
        if h < layers[i + 1][0]:
            return i
    return len(layers) - 1


def temperature_at_altitude(h: float) -> float:
    """高度 h(m) -> 温度(K)，按 ISA 分层线性插值。"""
    i = _layer_index_for_altitude(h)
    h_b, t_b, _, lapse = C.ISA_LAYERS[i]
    return t_b + lapse * (h - h_b)


def pressure_at_altitude(h: float) -> float:
    """高度 h(m) -> 气压(Pa)，按 ISA 分层压高公式。"""
    i = _layer_index_for_altitude(h)
    h_b, t_b, p_b, lapse = C.ISA_LAYERS[i]
    dh = h - h_b
    if abs(lapse) < 1e-12:
        return p_b * math.exp(-C.GRAVITY * dh / (C.R_D * t_b))
    exponent = C.GRAVITY / (C.R_D * lapse)
    return p_b * (t_b / (t_b + lapse * dh)) ** exponent


def _invert_layer(p: float, h_b: float, t_b: float, p_b: float, lapse: float) -> float:
    """单层内由气压反演相对高度增量 dh。"""
    if abs(lapse) < 1e-12:
        return -(C.R_D * t_b / C.GRAVITY) * math.log(p / p_b)
    exponent = C.R_D * lapse / C.GRAVITY
    return (t_b / lapse) * ((p_b / p) ** exponent - 1.0)


def altitude_from_pressure(p: float) -> float:
    """气压 p(Pa) -> 高度(m)，按 ISA 分层反演。

    这是「探空气球气压测高」的流体力学实现：气球实测气压，
    通过静力学平衡导出的压高关系反推所在几何高度。
    """
    layers = C.ISA_LAYERS
    if p >= layers[0][2]:
        h_b, t_b, p_b, lapse = layers[0]
        return h_b + _invert_layer(p, h_b, t_b, p_b, lapse)
    for i in range(len(layers) - 1):
        p_top = pressure_at_altitude(layers[i + 1][0])
        if p_top <= p <= layers[i][2]:
            h_b, t_b, p_b, lapse = layers[i]
            return h_b + _invert_layer(p, h_b, t_b, p_b, lapse)
    h_b, t_b, p_b, lapse = layers[-1]
    return h_b + _invert_layer(p, h_b, t_b, p_b, lapse)


def air_density(p: float, t: float) -> float:
    """气压 p(Pa)、温度 t(K) -> 空气密度(kg/m^3)，理想气体状态方程 ρ = p/(R_d·T)。"""
    if t <= 0.0:
        return 0.0
    return p / (C.R_D * t)


def speed_of_sound(t: float) -> float:
    """温度 t(K) -> 声速(m/s)，a = sqrt(γ·R_d·T)。"""
    return math.sqrt(C.GAMMA * C.R_D * t)
