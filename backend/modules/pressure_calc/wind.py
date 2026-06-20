"""地转风计算：由气压梯度反推风速。

地转风是大尺度大气运动中「气压梯度力」与「科氏力」平衡时的风，
是流体力学(地球物理流体动力学)中最基本的风场诊断关系：

    f (k̂ × v_g) = -(1/ρ) ∇P

其中科氏参数 f = 2Ω sinφ。展开分量：
    u_g(东向) = -(1/(ρ·f)) · ∂P/∂y
    v_g(北向) =  (1/(ρ·f)) · ∂P/∂x

探空气球沿航迹采集不同位置的气压，本模块用局部邻域最小二乘
拟合气压场平面，估计 ∇P，再代入地转关系得到风矢量。
"""
from __future__ import annotations

import math

import numpy as np

from modules.pressure_calc import constants as C


def latlon_to_xy(lat, lon, lat0: float, lon0: float):
    """经纬度转局地平面坐标(米)。

    x = 东向，y = 北向。采用等距矩形近似(小范围适用)。
    """
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    cos_lat0 = math.cos(math.radians(lat0))
    x = C.EARTH_RADIUS * np.radians(lon - lon0) * cos_lat0
    y = C.EARTH_RADIUS * np.radians(lat - lat0)
    return x, y


def fit_pressure_gradient(x, y, p) -> tuple[float, float]:
    """最小二乘拟合 P ≈ a·x + b·y + c，返回 (dP/dx, dP/dy)。

    将 x、y、p 中心化后，常数项吸收为 p 的均值，仅解 [a, b]。
    点数不足时返回零梯度。
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    if p.size < 3 or x.size < 3:
        return 0.0, 0.0
    A = np.column_stack([x - x.mean(), y - y.mean()])
    try:
        sol, *_ = np.linalg.lstsq(A, p - p.mean(), rcond=None)
    except np.linalg.LinAlgError:
        return 0.0, 0.0
    return float(sol[0]), float(sol[1])


def local_pressure_gradient(x, y, p, window: int = 5):
    """对每个采样点用邻域窗口拟合局部气压梯度。

    返回逐点的 (dP/dx[], dP/dy[])，使风场随航迹变化而非全局常量。
    """
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    n = p.size
    dPdx = np.zeros(n)
    dPdy = np.zeros(n)
    half = max(1, window // 2)
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        a, b = fit_pressure_gradient(x[lo:hi], y[lo:hi], p[lo:hi])
        dPdx[i] = a
        dPdy[i] = b
    return dPdx, dPdy


def coriolis_parameter(lat: float) -> float:
    """科氏参数 f = 2Ω sinφ。"""
    return 2.0 * C.EARTH_OMEGA * math.sin(math.radians(lat))


def geostrophic_wind(dPdx: float, dPdy: float, rho: float, lat: float) -> tuple[float, float, float, float]:
    """由气压梯度与空气密度计算地转风。

    返回 (u_东向, v_北向, 风速, 风向[吹向, 正北顺时针 0~360°])。
    退化情形(赤道附近 f≈0 或密度异常)返回零风。
    """
    f = coriolis_parameter(lat)
    if abs(f) < 1e-10 or rho <= 0.0:
        return 0.0, 0.0, 0.0, 0.0
    u = -(1.0 / (rho * f)) * dPdy
    v = (1.0 / (rho * f)) * dPdx
    speed = math.hypot(u, v)
    direction = (math.degrees(math.atan2(u, v)) + 360.0) % 360.0
    return u, v, speed, direction
