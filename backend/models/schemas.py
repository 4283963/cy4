"""Pydantic 数据模型：请求/响应的类型契约。"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class BalloonReading(BaseModel):
    """气球传回的一条原始散点读数。

    timestamp: 时间戳(秒)
    pressure_hpa: 气压(百帕)
    temperature_c: 温度(摄氏度)
    lat, lon: 经纬度(可选，用于风场反演)
    """
    timestamp: float
    pressure_hpa: float
    temperature_c: float
    lat: Optional[float] = None
    lon: Optional[float] = None


class WindVector(BaseModel):
    """风矢量：东向分量 u、北向分量 v、合速度、方向(吹向)。"""
    u_mps: float
    v_mps: float
    speed_mps: float
    direction_deg: float


class AtmosphereState(BaseModel):
    """气压反演得到的某时刻大气状态。"""
    timestamp: float
    altitude_m: float
    pressure_hpa: float
    temperature_c: float
    temperature_k: float
    density_kg_m3: float
    sound_speed_mps: float
    ascent_rate_mps: float
    wind: WindVector
    lat: Optional[float] = None
    lon: Optional[float] = None


class ComputeResponse(BaseModel):
    """POST /compute 的响应：原始读数反演结果。"""
    balloon_id: str
    states: list[AtmosphereState]
    reading_count: int


class TrajectoryPoint(BaseModel):
    """轨迹推演中的一个采样点。"""
    t_sec: float
    lat: float
    lon: float
    alt: float
    phase: str
    wind_u: float
    wind_v: float


class LandingPoint(BaseModel):
    """落点预测结果。"""
    lat: float
    lon: float
    alt: float
    flight_time_sec: float


class PredictRequest(BaseModel):
    """POST /predict 的请求体。

    由外部先通过 /compute 得到反演状态与风廓线，再提交初值与风廓线来推演。
    但为简化调用，也可直接附原始 readings 让服务端自动完成反演。
    """
    balloon_id: str
    initial_lat: float
    initial_lon: float
    initial_alt: float
    initial_phase: str = Field(default="ascent", pattern="^(ascent|burst|descent)$")
    readings: Optional[list[BalloonReading]] = None
    wind_profile: Optional[list[dict]] = None
    balloon_spec: Optional[dict] = None
    dt_sec: float = 30.0
    max_steps: int = 2000


class PredictResponse(BaseModel):
    """POST /predict 的响应：预测轨迹与落点。"""
    balloon_id: str
    trajectory: list[TrajectoryPoint]
    landing: LandingPoint


class SimulateResponse(BaseModel):
    """GET /simulate 的响应：一次性完成反演+推演，方便前端直接调用。"""
    balloon_id: str
    states: list[AtmosphereState]
    predicted_trajectory: list[TrajectoryPoint]
    landing: LandingPoint
