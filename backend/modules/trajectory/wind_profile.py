"""风廓线插值：由离散(高度, 风矢量)样本构造任意高度的风函数。

气压反演模块输出逐采样点的高度与风速，这些样本高度稀疏且不规则。
本模块将它们整理为高度单调上升的廓线，对任意查询高度 h 输出对应的
(u, v) 风矢量，供轨迹推演模块使用。
"""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np


class WindProfile:
    """高度单调的风廓线，支持任意高度线性插值。

    输入按高度升序排列。若输入为空，则提供零风背景(无风场可用时的降级)。
    超出高度范围的查询返回最近边界的值。
    """

    def __init__(self, altitudes: Sequence[float], u_wind: Sequence[float], v_wind: Sequence[float]):
        a = np.asarray(altitudes, dtype=float)
        u = np.asarray(u_wind, dtype=float)
        v = np.asarray(v_wind, dtype=float)

        if a.size != u.size or a.size != v.size:
            raise ValueError("WindProfile 三组序列长度必须一致。")

        if a.size >= 2:
            order = np.argsort(a)
            self._alt = a[order]
            self._u = u[order]
            self._v = v[order]
        elif a.size == 1:
            self._alt = np.array([a[0] - 1.0, a[0] + 1.0], dtype=float)
            self._u = np.array([u[0], u[0]], dtype=float)
            self._v = np.array([v[0], v[0]], dtype=float)
        else:
            self._alt = np.array([0.0, 1.0], dtype=float)
            self._u = np.zeros(2, dtype=float)
            self._v = np.zeros(2, dtype=float)

        # 构造经度向随高度增加的涡旋风场基底，使零输入下也有可见风场
        self._alt_min = float(self._alt[0])
        self._alt_max = float(self._alt[-1])

    def at(self, h: float) -> tuple[float, float]:
        """查询高度 h(m) 处的 (u_东向, v_北向) 风矢量 (m/s)。"""
        h_clamped = min(self._alt_max, max(self._alt_min, h))
        u = float(np.interp(h_clamped, self._alt, self._u))
        v = float(np.interp(h_clamped, self._alt, self._v))
        return u, v

    def speed(self, h: float) -> float:
        u, v = self.at(h)
        return math.hypot(u, v)

    def wind_from_atmosphere_states(self, states: Sequence[dict]) -> "WindProfile":
        """静态便捷方法：从气压反演输出的 states 列表构造风廓线。"""
        alts = [s["altitude_m"] for s in states if math.isfinite(s.get("altitude_m", float("nan")))]
        us = [s["wind_u_mps"] for s in states if math.isfinite(s.get("wind_u_mps", float("nan")))]
        vs = [s["wind_v_mps"] for s in states if math.isfinite(s.get("wind_v_mps", float("nan")))]
        return WindProfile(alts, us, vs)
