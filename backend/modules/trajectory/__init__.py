"""轨迹推演模块。

在气压反演得到的高度与风场基础上，预测气球后续飞行轨迹与落点。

子模块:
- physics: 气球运动方程(上升/爆裂/下降三阶段)
- wind_profile: 风廓线插值(高度->风矢量)
- predictor: 数值积分推演轨迹与落点
"""
from __future__ import annotations

from modules.trajectory.predictor import TrajectoryPredictor

__all__ = ["TrajectoryPredictor"]
