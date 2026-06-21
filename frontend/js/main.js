/**
 * 探空气球三维轨迹可视化 - 核心逻辑 (鲁棒版)
 *
 * 严格初始化顺序:
 *   DOMContentLoaded → initScene(Scene/Camera/Renderer) → initLights → initStars
 *   → initEarth → bindUI → animate → loadData
 *
 * 每一步都有 try/catch 和 null 检查，任何一步失败都提供可见的降级方案。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- 常量 ---
const EARTH_R = 100;
const ALT_SCALE = 0.0015;
const API_BASE = (() => {
    try {
        if (window.location.protocol === 'file:') return 'http://localhost:8000/api';
        if (window.location.origin.includes('localhost')) return window.location.origin + '/api';
        return '/api';
    } catch (_) {
        return 'http://localhost:8000/api';
    }
})();

// --- Three.js 基础对象 (延迟初始化) ---
let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let clock = null;

// --- 场景元素 ---
let earthGroup = null;
let historyLine = null;
let predictedLine = null;
let balloonMesh = null;
let burstMarker = null;
let landingMarker = null;
let stars = null;

// --- 数据状态 ---
let currentData = null;
let animationProgress = 0;
let isAnimating = true;
let autoRotate = true;
const animationSpeed = 0.15;

// --- DOM 元素 (延迟初始化) ---
let dom = null;

// ============================================================================
// 工具函数
// ============================================================================

function safeGet(id) {
    const el = document.getElementById(id);
    if (!el) console.warn('DOM element not found:', id);
    return el;
}

function initDom() {
    dom = {
        hudBalloonId: safeGet('hud-balloon-id'),
        hudAlt: safeGet('hud-alt'),
        hudPressure: safeGet('hud-pressure'),
        hudTemp: safeGet('hud-temp'),
        hudWind: safeGet('hud-wind'),
        hudDir: safeGet('hud-dir'),
        hudAscent: safeGet('hud-ascent'),
        hudTime: safeGet('hud-time'),
        hudLanding: safeGet('hud-landing'),
        landLat: safeGet('land-lat'),
        landLon: safeGet('land-lon'),
        landTime: safeGet('land-time'),
        btnLoad: safeGet('btn-load'),
        btnReload: safeGet('btn-reload'),
        seedInput: safeGet('seed-input'),
        toggleRotate: safeGet('toggle-auto-rotate'),
        toggleAnimate: safeGet('toggle-animate'),
        statusIndicator: safeGet('status-indicator'),
        statusText: safeGet('status-text'),
        loading: safeGet('loading'),
        sceneContainer: safeGet('scene-container'),
    };
}

function checkWebGLSupport() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
            || canvas.getContext('experimental-webgl');
        if (!gl) {
            console.error('WebGL 不受支持');
            return false;
        }
        return true;
    } catch (e) {
        console.error('WebGL 检测失败:', e);
        return false;
    }
}

// ============================================================================
// 初始化 Three.js 场景 - 严格按顺序，每步都有错误保护
// ============================================================================

function initScene() {
    if (!dom || !dom.sceneContainer) {
        throw new Error('场景容器 DOM 未就绪');
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030712);
    try {
        scene.fog = new THREE.FogExp2(0x030712, 0.002);
    } catch (e) {
        console.warn('Fog 初始化失败，降级无雾:', e);
    }

    const aspect = Math.max(0.1, window.innerWidth / window.innerHeight);
    camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 5000);
    camera.position.set(0, 120, 280);
    camera.lookAt(0, 0, 0);

    if (!checkWebGLSupport()) {
        throw new Error('浏览器不支持 WebGL，无法渲染 3D 场景');
    }

    try {
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance',
        });
    } catch (e) {
        console.warn('高性能 WebGL 初始化失败，尝试基础配置:', e);
        renderer = new THREE.WebGLRenderer({ alpha: true });
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x030712, 1);

    try {
        if (THREE.ACESFilmicToneMapping !== undefined) {
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.1;
        }
    } catch (e) {
        console.warn('ToneMapping 设置失败:', e);
    }

    dom.sceneContainer.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 130;
    controls.maxDistance = 800;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;
    controls.target.set(0, 0, 0);
    controls.update();

    clock = new THREE.Clock();

    window.addEventListener('resize', onWindowResize);
}

function initLights() {
    if (!scene) return;
    try {
        scene.add(new THREE.AmbientLight(0x404060, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 1.2);
        sun.position.set(200, 150, 100);
        scene.add(sun);
        const fill = new THREE.DirectionalLight(0x38bdf8, 0.4);
        fill.position.set(-150, 50, -100);
        scene.add(fill);
        const rim = new THREE.PointLight(0xa78bfa, 1.5, 500);
        rim.position.set(-100, -50, 200);
        scene.add(rim);
    } catch (e) {
        console.error('灯光初始化失败:', e);
        if (!scene) return;
        scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    }
}

function initStars() {
    if (!scene) return;
    try {
        const starCount = 4000;
        const positions = new Float32Array(starCount * 3);
        const colors = new Float32Array(starCount * 3);

        for (let i = 0; i < starCount; i++) {
            const r = 1500 + Math.random() * 1000;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.cos(phi);
            positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

            const hue = 0.55 + Math.random() * 0.15;
            const sat = 0.3 + Math.random() * 0.4;
            const lig = 0.6 + Math.random() * 0.4;
            const col = new THREE.Color().setHSL(hue, sat, lig);
            colors[i * 3] = col.r;
            colors[i * 3 + 1] = col.g;
            colors[i * 3 + 2] = col.b;
        }

        const starGeometry = new THREE.BufferGeometry();
        starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const starMaterial = new THREE.PointsMaterial({
            size: 1.5,
            vertexColors: true,
            transparent: true,
            opacity: 0.9,
            sizeAttenuation: true,
        });

        stars = new THREE.Points(starGeometry, starMaterial);
        scene.add(stars);
    } catch (e) {
        console.error('星空初始化失败:', e);
    }
}

function makeFallbackEarth() {
    const group = new THREE.Group();
    try {
        const geo = new THREE.SphereGeometry(EARTH_R, 48, 48);
        const mat = new THREE.MeshPhongMaterial({
            color: 0x1e3a5f,
            emissive: 0x0f172a,
            emissiveIntensity: 0.2,
            shininess: 30,
        });
        group.add(new THREE.Mesh(geo, mat));

        const wireGeo = new THREE.SphereGeometry(EARTH_R + 0.5, 24, 16);
        const wireMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            wireframe: true,
            transparent: true,
            opacity: 0.15,
        });
        group.add(new THREE.Mesh(wireGeo, wireMat));
    } catch (e) {
        console.error('降级地球模型也失败了:', e);
    }
    return group;
}

function initEarth() {
    if (!scene) return;
    try {
        earthGroup = new THREE.Group();

        const earthGeo = new THREE.SphereGeometry(EARTH_R, 64, 64);
        const earthMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor1: { value: new THREE.Color(0x0f172a) },
                uColor2: { value: new THREE.Color(0x1e3a5f) },
                uGlowColor: { value: new THREE.Color(0x38bdf8) },
            },
            vertexShader: [
                'varying vec3 vNormal;',
                'varying vec3 vPosition;',
                'void main() {',
                '    vNormal = normalize(normalMatrix * normal);',
                '    vPosition = position;',
                '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
                '}'
            ].join('\n'),
            fragmentShader: [
                'varying vec3 vNormal;',
                'varying vec3 vPosition;',
                'uniform vec3 uColor1;',
                'uniform vec3 uColor2;',
                'uniform vec3 uGlowColor;',
                'void main() {',
                '    float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);',
                '    float lat = vPosition.y / ' + EARTH_R.toFixed(1) + ';',
                '    vec3 base = mix(uColor1, uColor2, lat * 0.5 + 0.5);',
                '    vec3 glow = uGlowColor * intensity * 0.8;',
                '    gl_FragColor = vec4(base + glow, 1.0);',
                '}'
            ].join('\n'),
        });
        earthGroup.add(new THREE.Mesh(earthGeo, earthMat));

        const atmosphereGeo = new THREE.SphereGeometry(EARTH_R * 1.08, 48, 48);
        const atmosphereMat = new THREE.ShaderMaterial({
            uniforms: {
                uGlowColor: { value: new THREE.Color(0x38bdf8) },
            },
            vertexShader: [
                'varying vec3 vNormal;',
                'void main() {',
                '    vNormal = normalize(normalMatrix * normal);',
                '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
                '}'
            ].join('\n'),
            fragmentShader: [
                'varying vec3 vNormal;',
                'uniform vec3 uGlowColor;',
                'void main() {',
                '    float intensity = pow(0.8 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);',
                '    gl_FragColor = vec4(uGlowColor, intensity * 0.5);',
                '}'
            ].join('\n'),
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
        });
        earthGroup.add(new THREE.Mesh(atmosphereGeo, atmosphereMat));

        const meridiansGroup = new THREE.Group();
        for (let lon = 0; lon < 12; lon++) {
            const points = [];
            const angle = (lon / 12) * Math.PI * 2;
            for (let lat = -90; lat <= 90; lat += 4) {
                const latRad = (lat * Math.PI) / 180;
                points.push(new THREE.Vector3(
                    EARTH_R * Math.cos(latRad) * Math.cos(angle),
                    EARTH_R * Math.sin(latRad),
                    EARTH_R * Math.cos(latRad) * Math.sin(angle)
                ));
            }
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const mat = new THREE.LineBasicMaterial({
                color: 0x334155, transparent: true, opacity: 0.35,
            });
            meridiansGroup.add(new THREE.Line(geo, mat));
        }
        earthGroup.add(meridiansGroup);

        const parallelsGroup = new THREE.Group();
        for (let latIdx = 0; latIdx < 9; latIdx++) {
            const lat = -80 + latIdx * 20;
            if (Math.abs(lat) >= 90) continue;
            const latRad = (lat * Math.PI) / 180;
            const r = EARTH_R * Math.cos(latRad);
            const y = EARTH_R * Math.sin(latRad);
            const points = [];
            for (let a = 0; a <= 360; a += 5) {
                const ar = (a * Math.PI) / 180;
                points.push(new THREE.Vector3(r * Math.cos(ar), y, r * Math.sin(ar)));
            }
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const mat = new THREE.LineBasicMaterial({
                color: 0x334155, transparent: true, opacity: 0.35,
            });
            parallelsGroup.add(new THREE.Line(geo, mat));
        }
        earthGroup.add(parallelsGroup);

        const equatorPoints = [];
        for (let a = 0; a <= 360; a += 3) {
            const ar = (a * Math.PI) / 180;
            equatorPoints.push(new THREE.Vector3(EARTH_R * Math.cos(ar), 0, EARTH_R * Math.sin(ar)));
        }
        const equatorGeo = new THREE.BufferGeometry().setFromPoints(equatorPoints);
        const equatorMat = new THREE.LineBasicMaterial({
            color: 0x38bdf8, transparent: true, opacity: 0.4,
        });
        earthGroup.add(new THREE.Line(equatorGeo, equatorMat));

        scene.add(earthGroup);
    } catch (e) {
        console.error('地球 Shader 初始化失败，使用降级模型:', e);
        earthGroup = makeFallbackEarth();
        scene.add(earthGroup);
    }
}

// ============================================================================
// 坐标转换
// ============================================================================

function latLonAltToVec3(lat, lon, alt) {
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;
    const r = EARTH_R + (alt || 0) * ALT_SCALE;
    return new THREE.Vector3(
        r * Math.cos(latRad) * Math.cos(lonRad),
        r * Math.sin(latRad),
        r * Math.cos(latRad) * Math.sin(lonRad)
    );
}

const WIND_COLOR_LOW = new THREE.Color(0x4ade80);
const WIND_COLOR_MID = new THREE.Color(0xfacc15);
const WIND_COLOR_HIGH = new THREE.Color(0xf87171);

function windSpeedToColor(t) {
    const tt = Math.max(0, Math.min(1, t));
    if (tt < 0.5) {
        return WIND_COLOR_LOW.clone().lerp(WIND_COLOR_MID, tt * 2);
    } else {
        return WIND_COLOR_MID.clone().lerp(WIND_COLOR_HIGH, (tt - 0.5) * 2);
    }
}

function buildVertexColors(speeds) {
    const colors = new Float32Array(speeds.length * 3);
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < speeds.length; i++) {
        if (speeds[i] < vmin) vmin = speeds[i];
        if (speeds[i] > vmax) vmax = speeds[i];
    }
    const range = vmax - vmin;
    for (let i = 0; i < speeds.length; i++) {
        const t = range > 0 ? (speeds[i] - vmin) / range : 0.5;
        const c = windSpeedToColor(t);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
    }
    return colors;
}

function getWindSpeedRange(speeds) {
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < speeds.length; i++) {
        if (speeds[i] < vmin) vmin = speeds[i];
        if (speeds[i] > vmax) vmax = speeds[i];
    }
    if (vmin === Infinity) return { min: 0, max: 0 };
    return { min: vmin, max: vmax };
}

// ============================================================================
// 创建轨迹与标记
// ============================================================================

function createTrajectoryLine(points, color, dashed, windSpeeds) {
    if (!points || points.length < 2) return null;
    try {
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const useVertexColors = windSpeeds && windSpeeds.length === points.length;

        if (useVertexColors) {
            geo.setAttribute('color', new THREE.BufferAttribute(buildVertexColors(windSpeeds), 3));
        }

        let mat;
        if (dashed) {
            mat = new THREE.LineDashedMaterial({
                color: color, dashSize: 3, gapSize: 2,
                transparent: true, opacity: 0.85,
                vertexColors: useVertexColors,
            });
        } else {
            mat = new THREE.LineBasicMaterial({
                color: color, transparent: true, opacity: 0.95,
                vertexColors: useVertexColors,
            });
        }
        const line = new THREE.Line(geo, mat);
        if (dashed) line.computeLineDistances();

        const glowColor = useVertexColors ? 0xffffff : color;
        const glowMat = new THREE.LineBasicMaterial({
            color: glowColor, transparent: true, opacity: 0.25,
            vertexColors: useVertexColors,
        });
        const glowLine = new THREE.Line(geo, glowMat);

        const group = new THREE.Group();
        group.add(glowLine);
        group.add(line);
        return group;
    } catch (e) {
        console.error('创建轨迹线失败:', e);
        return null;
    }
}

function createBalloon() {
    try {
        const group = new THREE.Group();
        const balloonGeo = new THREE.SphereGeometry(3.5, 24, 24);
        const balloonMat = new THREE.MeshPhongMaterial({
            color: 0xfb923c,
            emissive: 0xfb923c,
            emissiveIntensity: 0.3,
            transparent: true,
            opacity: 0.85,
            shininess: 100,
        });
        group.add(new THREE.Mesh(balloonGeo, balloonMat));

        const glowGeo = new THREE.SphereGeometry(4.5, 24, 24);
        const glowMat = new THREE.MeshBasicMaterial({
            color: 0xfb923c, transparent: true, opacity: 0.25, side: THREE.BackSide,
        });
        group.add(new THREE.Mesh(glowGeo, glowMat));

        const trailGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -3.5, 0),
            new THREE.Vector3(0, -7, 0),
        ]);
        group.add(new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
            color: 0xfbbf24, transparent: true, opacity: 0.6,
        })));

        const payloadGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
        const payloadMat = new THREE.MeshPhongMaterial({
            color: 0x94a3b8,
            emissive: 0x38bdf8,
            emissiveIntensity: 0.2,
        });
        const payload = new THREE.Mesh(payloadGeo, payloadMat);
        payload.position.y = -7.5;
        group.add(payload);

        group.add(new THREE.PointLight(0xfb923c, 1, 40));
        return group;
    } catch (e) {
        console.error('创建气球失败:', e);
        const fallbackGeo = new THREE.SphereGeometry(4, 16, 16);
        const fallbackMat = new THREE.MeshBasicMaterial({ color: 0xfb923c });
        return new THREE.Mesh(fallbackGeo, fallbackMat);
    }
}

function createMarker(color, size) {
    try {
        const s = size || 4;
        const group = new THREE.Group();

        const coreGeo = new THREE.SphereGeometry(s * 0.5, 16, 16);
        group.add(new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: color })));

        const ringGeo = new THREE.RingGeometry(s * 0.8, s, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color: color, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.userData.isRing = true;
        group.add(ring);

        const glowGeo = new THREE.SphereGeometry(s * 1.5, 24, 24);
        const glowMat = new THREE.MeshBasicMaterial({
            color: color, transparent: true, opacity: 0.2, side: THREE.BackSide,
        });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.userData.isGlow = true;
        group.add(glow);

        return group;
    } catch (e) {
        console.error('创建标记失败:', e);
        const fallbackGeo = new THREE.SphereGeometry((size || 4) * 0.6, 12, 12);
        return new THREE.Mesh(fallbackGeo, new THREE.MeshBasicMaterial({ color: color }));
    }
}

// ============================================================================
// 数据加载与场景构建
// ============================================================================

async function loadData(seed) {
    setStatus('loading', '正在获取探空数据...');
    showLoading(true);
    try {
        const url = `${API_BASE}/balloons/simulate?seed=${seed}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        currentData = data;
        buildScene(data);
        setStatus('ready', '数据就绪 · 气球 ' + data.balloon_id);
        return data;
    } catch (err) {
        console.error('加载数据失败:', err);
        setStatus('error', '加载失败，使用示例数据');
        const fallback = generateFallbackData(seed);
        currentData = fallback;
        buildScene(fallback);
        setStatus('ready', '示例数据 · 气球 ' + fallback.balloon_id);
        return fallback;
    } finally {
        showLoading(false);
    }
}

function generateFallbackData(seed) {
    const rng = mulberry32(seed);
    const states = [];
    let lat = 39.9042, lon = 116.4074;
    for (let t = 0; t < 3600; t += 15) {
        const alt = t * 5;
        const p_hpa = 1013 * Math.exp(-alt / 8500) + rng() * 0.5;
        const temp = 15 - 0.0065 * alt + rng() * 0.3;
        const windSpeed = 15 + alt / 1000 * 2;
        const windDir = 270 + rng() * 20;
        lat += (windSpeed * Math.sin(windDir * Math.PI / 180) / 6371000) * (180 / Math.PI) * 15;
        lon += (windSpeed * Math.cos(windDir * Math.PI / 180) / (6371000 * Math.cos(lat * Math.PI / 180))) * (180 / Math.PI) * 15;
        states.push({
            timestamp: t,
            altitude_m: alt,
            pressure_hpa: p_hpa,
            temperature_c: temp,
            temperature_k: temp + 273.15,
            density_kg_m3: p_hpa * 100 / (287 * (temp + 273.15)),
            sound_speed_mps: Math.sqrt(1.4 * 287 * (temp + 273.15)),
            ascent_rate_mps: 5,
            wind: {
                u_mps: windSpeed * Math.sin(windDir * Math.PI / 180),
                v_mps: windSpeed * Math.cos(windDir * Math.PI / 180),
                speed_mps: windSpeed,
                direction_deg: windDir,
            },
            lat: lat,
            lon: lon,
        });
        if (alt >= 30000) break;
    }
    const predicted = [];
    let plat = lat, plon = lon, palt = 30000;
    for (let t = 0; t < 4000; t += 30) {
        const windSpeed = 30;
        const windDir = 260;
        plat += (windSpeed * Math.sin(windDir * Math.PI / 180) / 6371000) * (180 / Math.PI) * 30;
        plon += (windSpeed * Math.cos(windDir * Math.PI / 180) / (6371000 * Math.cos(plat * Math.PI / 180))) * (180 / Math.PI) * 30;
        palt = Math.max(0, 30000 - t * 6);
        predicted.push({
            t_sec: t, lat: plat, lon: plon, alt: palt,
            phase: palt > 0 ? 'descent' : 'landed',
            wind_u: windSpeed * Math.sin(windDir * Math.PI / 180),
            wind_v: windSpeed * Math.cos(windDir * Math.PI / 180),
        });
        if (palt <= 0) break;
    }
    return {
        balloon_id: 'demo-' + seed,
        states: states,
        predicted_trajectory: predicted,
        landing: {
            lat: plat, lon: plon, alt: 0,
            flight_time_sec: predicted.length * 30,
        },
    };
}

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildScene(data) {
    if (!scene) {
        console.error('buildScene 时 scene 为空');
        return;
    }
    clearScene();

    const historyStates = (data.states || []).filter(s => s && s.lat != null && s.lon != null);
    const historyPoints = historyStates.map(s => latLonAltToVec3(s.lat, s.lon, s.altitude_m));
    const historyWindSpeeds = historyStates.map(s => (s.wind && s.wind.speed_mps) ? s.wind.speed_mps : 0);

    if (historyPoints.length >= 2) {
        historyLine = createTrajectoryLine(historyPoints, 0xfb923c, false, historyWindSpeeds);
        if (historyLine) scene.add(historyLine);
    }

    const predictStates = (data.predicted_trajectory || []).filter(p => p && p.lat != null && p.lon != null);
    const predictPoints = predictStates.map(p => latLonAltToVec3(p.lat, p.lon, p.alt));
    const predictWindSpeeds = predictStates.map(p => Math.hypot(p.wind_u || 0, p.wind_v || 0));

    if (predictPoints.length >= 2) {
        predictedLine = createTrajectoryLine(predictPoints, 0x38bdf8, true, predictWindSpeeds);
        if (predictedLine) scene.add(predictedLine);
    }

    balloonMesh = createBalloon();
    const firstPos = historyPoints[0] || predictPoints[0] || new THREE.Vector3(0, EARTH_R, 0);
    balloonMesh.position.copy(firstPos);
    scene.add(balloonMesh);

    let maxAlt = -1, maxIdx = 0;
    (data.states || []).forEach((s, i) => {
        if (s && s.altitude_m > maxAlt) {
            maxAlt = s.altitude_m;
            maxIdx = i;
        }
    });
    if (historyPoints[maxIdx]) {
        burstMarker = createMarker(0xf87171, 4.5);
        burstMarker.position.copy(historyPoints[maxIdx]);
        burstMarker.userData.billboard = true;
        scene.add(burstMarker);
    }

    if (data.landing && data.landing.lat != null) {
        landingMarker = createMarker(0x4ade80, 5);
        const landingPos = latLonAltToVec3(data.landing.lat, data.landing.lon, 0);
        landingMarker.position.copy(landingPos);
        landingMarker.userData.billboard = true;
        scene.add(landingMarker);

        if (dom && dom.hudLanding) dom.hudLanding.classList.add('visible');
        if (dom && dom.landLat) dom.landLat.textContent = data.landing.lat.toFixed(4) + '\u00B0';
        if (dom && dom.landLon) dom.landLon.textContent = data.landing.lon.toFixed(4) + '\u00B0';
        if (dom && dom.landTime) {
            const ft = data.landing.flight_time_sec;
            dom.landTime.textContent = Math.floor(ft / 60) + '\u5206' + Math.floor(ft % 60) + '\u79D2';
        }
    }

    if (dom && dom.hudBalloonId) dom.hudBalloonId.textContent = data.balloon_id || '--';
    animationProgress = 0;

    if (historyPoints.length > 0 && camera && controls) {
        const start = historyPoints[0];
        const offset = new THREE.Vector3(80, 60, 80);
        camera.position.copy(start).add(offset);
        controls.target.copy(start);
        controls.update();
    }
}

function clearScene() {
    if (!scene) return;
    const objects = [historyLine, predictedLine, balloonMesh, burstMarker, landingMarker];
    objects.forEach(obj => {
        if (obj) {
            try { scene.remove(obj); } catch (_) {}
            try {
                if (typeof obj.traverse === 'function') {
                    obj.traverse(child => {
                        if (child.geometry) try { child.geometry.dispose(); } catch (_) {}
                        if (child.material) {
                            try {
                                const mats = Array.isArray(child.material) ? child.material : [child.material];
                                mats.forEach(m => { try { m.dispose(); } catch (_) {} });
                            } catch (_) {}
                        }
                    });
                }
            } catch (_) {}
        }
    });
    historyLine = null;
    predictedLine = null;
    balloonMesh = null;
    burstMarker = null;
    landingMarker = null;
    if (dom && dom.hudLanding) dom.hudLanding.classList.remove('visible');
}

// ============================================================================
// 动画系统
// ============================================================================

function interpolateOnPath(points, progress) {
    if (!points || points.length < 2) {
        return points && points[0] ? points[0] : new THREE.Vector3();
    }
    const totalSegments = points.length - 1;
    const exact = progress * totalSegments;
    const idx = Math.min(Math.floor(exact), totalSegments - 1);
    const frac = exact - idx;
    const p0 = points[Math.max(0, Math.min(idx, points.length - 1))];
    const p1 = points[Math.max(0, Math.min(idx + 1, points.length - 1))];
    if (!p0 || !p1) return new THREE.Vector3();
    return new THREE.Vector3().lerpVectors(p0, p1, frac);
}

function getStateAtProgress(data, progress) {
    const all = data.states;
    if (!all || all.length === 0) return null;
    const total = all.length - 1;
    const exact = progress * total;
    const idx = Math.min(Math.floor(exact), Math.max(0, total - 1));
    const frac = exact - idx;
    if (idx < 0 || idx + 1 >= all.length) return all[Math.min(idx, all.length - 1)];
    const s0 = all[idx], s1 = all[idx + 1];
    if (!s0 || !s1) return s0 || s1 || null;
    return {
        timestamp: lerp(s0.timestamp, s1.timestamp, frac),
        altitude_m: lerp(s0.altitude_m, s1.altitude_m, frac),
        pressure_hpa: lerp(s0.pressure_hpa, s1.pressure_hpa, frac),
        temperature_c: lerp(s0.temperature_c, s1.temperature_c, frac),
        wind_speed_mps: lerp(s0.wind && s0.wind.speed_mps ? s0.wind.speed_mps : 0,
                              s1.wind && s1.wind.speed_mps ? s1.wind.speed_mps : 0, frac),
        wind_direction_deg: lerp(s0.wind && s0.wind.direction_deg ? s0.wind.direction_deg : 0,
                                  s1.wind && s1.wind.direction_deg ? s1.wind.direction_deg : 0, frac),
        ascent_rate_mps: lerp(s0.ascent_rate_mps, s1.ascent_rate_mps, frac),
    };
}

function lerp(a, b, t) {
    if (a == null) a = 0;
    if (b == null) b = 0;
    return a + (b - a) * t;
}

function updateHUD(state) {
    if (!state || !dom) return;
    if (dom.hudAlt) dom.hudAlt.textContent = Math.round(state.altitude_m).toLocaleString();
    if (dom.hudPressure) dom.hudPressure.textContent = state.pressure_hpa.toFixed(1);
    if (dom.hudTemp) dom.hudTemp.textContent = state.temperature_c.toFixed(1);
    if (dom.hudWind) dom.hudWind.textContent = state.wind_speed_mps.toFixed(1);
    if (dom.hudDir) dom.hudDir.textContent = Math.round(state.wind_direction_deg);
    if (dom.hudAscent) dom.hudAscent.textContent = state.ascent_rate_mps.toFixed(2);
    if (dom.hudTime) dom.hudTime.textContent = Math.round(state.timestamp).toLocaleString();
}

function updateAnimation(delta) {
    if (!currentData || !isAnimating) return;

    animationProgress += delta * animationSpeed;
    if (animationProgress > 1) animationProgress = 0;

    const historyPoints = (currentData.states || [])
        .filter(s => s && s.lat != null && s.lon != null)
        .map(s => latLonAltToVec3(s.lat, s.lon, s.altitude_m));
    const predictPoints = (currentData.predicted_trajectory || [])
        .map(p => latLonAltToVec3(p.lat, p.lon, p.alt));

    const allPoints = [...historyPoints, ...predictPoints];
    if (allPoints.length >= 2) {
        const pos = interpolateOnPath(allPoints, animationProgress);
        if (balloonMesh) {
            balloonMesh.position.copy(pos);
            balloonMesh.rotation.y += delta * 0.5;
            if (balloonMesh.children && balloonMesh.children[0]) {
                balloonMesh.children[0].position.y = Math.sin((clock ? clock.elapsedTime : 0) * 2) * 0.5;
            }
        }
    }

    if (historyPoints.length > 0) {
        const historyProgress = Math.min(1, animationProgress * allPoints.length / historyPoints.length);
        if (historyProgress < 1) {
            const state = getStateAtProgress(currentData, historyProgress);
            if (state) updateHUD(state);
        } else if ((currentData.predicted_trajectory || []).length > 0 && predictPoints.length > 0) {
            const predictProgress = Math.min(1,
                (animationProgress * allPoints.length - historyPoints.length) / Math.max(1, predictPoints.length));
            const ptIdx = Math.floor(predictProgress * ((currentData.predicted_trajectory || []).length - 1));
            const pt = currentData.predicted_trajectory[Math.min(ptIdx, currentData.predicted_trajectory.length - 1)];
            if (pt) {
                const lastTs = currentData.states[currentData.states.length - 1]?.timestamp || 0;
                const windSpeed = Math.hypot(pt.wind_u || 0, pt.wind_v || 0);
                const windDir = ((Math.atan2(pt.wind_u || 0, pt.wind_v || 0) * 180 / Math.PI) + 360) % 360;
                updateHUD({
                    timestamp: lastTs + pt.t_sec,
                    altitude_m: pt.alt,
                    pressure_hpa: 1013 * Math.exp(-pt.alt / 8500),
                    temperature_c: 15 - 0.0065 * pt.alt,
                    wind_speed_mps: windSpeed,
                    wind_direction_deg: windDir,
                    ascent_rate_mps: pt.phase === 'descent' ? -6 : 5,
                });
            }
        }
    }
}

function updateMarkers() {
    if (!clock || !camera) return;
    const time = clock.elapsedTime;
    [burstMarker, landingMarker].forEach(marker => {
        if (!marker || !marker.children) return;
        if (marker.userData.billboard) {
            marker.children.forEach(child => {
                if (child.userData && child.userData.isRing && typeof child.lookAt === 'function') {
                    child.lookAt(camera.position);
                }
            });
        }
        marker.children.forEach(child => {
            if (!child.userData) return;
            if (child.userData.isRing) {
                const sc = 1 + Math.sin(time * 3) * 0.2;
                child.scale.set(sc, sc, sc);
                if (child.material) child.material.opacity = 0.5 + Math.sin(time * 3) * 0.3;
            }
            if (child.userData.isGlow) {
                const sc = 1 + Math.sin(time * 2) * 0.15;
                child.scale.set(sc, sc, sc);
            }
        });
    });
}

function animate() {
    requestAnimationFrame(animate);
    if (!scene || !camera || !renderer) return;

    const delta = clock ? clock.getDelta() : 0.016;

    if (controls) {
        controls.autoRotate = autoRotate;
        controls.update();
    }

    updateAnimation(delta);
    updateMarkers();

    if (stars && typeof stars.rotation !== 'undefined') {
        stars.rotation.y += delta * 0.01;
    }

    try {
        renderer.render(scene, camera);
    } catch (e) {
        console.error('渲染循环错误:', e);
    }
}

// ============================================================================
// UI 与状态
// ============================================================================

function bindUI() {
    if (!dom) return;
    if (dom.btnLoad) dom.btnLoad.addEventListener('click', () => {
        const seed = parseInt(dom.seedInput ? dom.seedInput.value : '42') || 42;
        loadData(seed);
    });
    if (dom.btnReload) dom.btnReload.addEventListener('click', () => {
        if (dom.seedInput) dom.seedInput.value = ((parseInt(dom.seedInput.value) || 42) + 1).toString();
        const seed = dom.seedInput ? (parseInt(dom.seedInput.value) || 42) : 42;
        loadData(seed);
    });
    if (dom.toggleRotate) dom.toggleRotate.addEventListener('change', (e) => {
        autoRotate = e.target.checked;
    });
    if (dom.toggleAnimate) dom.toggleAnimate.addEventListener('change', (e) => {
        isAnimating = e.target.checked;
    });
    if (dom.seedInput) dom.seedInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && dom.btnLoad) dom.btnLoad.click();
    });
}

function setStatus(type, text) {
    if (!dom) return;
    if (dom.statusIndicator) dom.statusIndicator.className = 'status ' + type;
    if (dom.statusText) dom.statusText.textContent = text;
}

function showLoading(show) {
    if (!dom || !dom.loading) return;
    dom.loading.classList.toggle('active', !!show);
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================================================
// 启动
// ============================================================================

async function main() {
    console.log('%c探空气球三维可视化启动中...', 'color:#38bdf8;font-weight:bold');

    initDom();
    setStatus('loading', '等待 DOM 就绪...');

    try {
        initScene();
        console.log('%c✓ Scene / Camera / Renderer 初始化完成', 'color:#4ade80');
    } catch (e) {
        console.error('Scene 初始化失败:', e);
        setStatus('error', '3D 场景初始化失败: ' + e.message);
        return;
    }

    setStatus('loading', '加载灯光与星空...');
    initLights();
    initStars();
    console.log('%c✓ 灯光与星空加载完成', 'color:#4ade80');

    setStatus('loading', '构建地球模型...');
    initEarth();
    console.log('%c✓ 地球模型加载完成', 'color:#4ade80');

    bindUI();
    setStatus('loading', '启动渲染循环...');
    animate();
    console.log('%c✓ 渲染循环启动', 'color:#4ade80');

    const seed = dom && dom.seedInput ? (parseInt(dom.seedInput.value) || 42) : 42;
    await loadData(seed);
    console.log('%c✓ 数据加载完成', 'color:#4ade80');
}

window.addEventListener('error', (e) => {
    console.error('全局错误:', e.error || e.message);
    try { setStatus('error', '前端错误: ' + (e.message || '未知错误')); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('未处理的 Promise:', e.reason);
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
} else {
    main();
}
