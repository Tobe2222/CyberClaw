/**
 * CybermonViewer — Three.js 3D companion renderer.
 * This file is bundled by esbuild into cybermon-viewer.bundle.js
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Shared GLTF cache across all viewers
const _gltfCache = {};

class CybermonViewer {
  constructor(containerId, opts = {}) {
    this.container = typeof containerId === 'string'
      ? document.getElementById(containerId)
      : containerId; // accept DOM element directly
    if (!this.container) return;
    this.interactive = opts.interactive !== false; // drag to rotate (default true)

    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.model = null;
    this.animId = null;
    this.isDragging = false;
    this.dragStartX = 0;
    this.modelRotationY = 0;
    this.momentum = 0;
    this.loader = new GLTFLoader();
    this.modelCache = {};

    this._initRenderer();
    this._initCamera();
    this._initLighting();
    this._initEnvironment();
    this._initEvents();
    this._animate();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x87CEEB, 1); // sky blue fallback
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    const w = this.container.clientWidth || 200;
    const h = this.container.clientHeight || 200;
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    // Only canvas captures pointer events for rotation
    this.renderer.domElement.style.pointerEvents = 'auto';

    this.resizeObs = new ResizeObserver(() => {
      const cw = this.container.clientWidth || 200;
      const ch = this.container.clientHeight || 200;
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(cw, ch);
    });
    this.resizeObs.observe(this.container);
  }

  _initCamera() {
    const w = this.container.clientWidth || 200;
    const h = this.container.clientHeight || 200;
    this.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 100);
    this.camera.position.set(0, 1.2, 4.5);
    this.camera.lookAt(0, 0.6, 0);
  }

  _initLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(2, 3, 4);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
    fill.position.set(-2, 1, -2);
    this.scene.add(fill);

    // Rim/element light — can be colored per companion
    this.rimLight = new THREE.PointLight(0x00aaff, 1.0, 10);
    this.rimLight.position.set(0, 2, -2);
    this.scene.add(this.rimLight);
  }

  _initEnvironment() {
    // === SKY DOME with gradient ===
    const skyGeo = new THREE.SphereGeometry(50, 32, 32);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor:    { value: new THREE.Color(0x4a90d9) },   // deeper blue
        bottomColor: { value: new THREE.Color(0xc8e6ff) },   // pale horizon
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPos;
        void main() {
          float h = normalize(vWorldPos).y;
          float t = clamp(h * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
        }
      `,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(sky);

    // === CLOUDS (billboard sprites) ===
    const cloudCanvas = document.createElement('canvas');
    cloudCanvas.width = 256;
    cloudCanvas.height = 128;
    const cctx = cloudCanvas.getContext('2d');
    cctx.fillStyle = 'rgba(0,0,0,0)';
    cctx.fillRect(0, 0, 256, 128);
    // Soft cloud shape
    const drawBlob = (x, y, rx, ry) => {
      cctx.beginPath();
      cctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      cctx.fill();
    };
    cctx.fillStyle = 'rgba(255,255,255,0.85)';
    drawBlob(128, 70, 80, 35);
    drawBlob(90, 60, 50, 30);
    drawBlob(170, 65, 55, 28);
    drawBlob(120, 50, 40, 22);
    drawBlob(150, 55, 45, 25);
    const cloudTex = new THREE.CanvasTexture(cloudCanvas);
    cloudTex.colorSpace = THREE.SRGBColorSpace;

    const cloudPositions = [
      { x: -8, y: 8, z: -15, s: 6 },
      { x: 5, y: 9, z: -18, s: 8 },
      { x: 15, y: 7.5, z: -12, s: 5 },
      { x: -15, y: 10, z: -20, s: 7 },
      { x: 0, y: 11, z: -22, s: 9 },
      { x: 10, y: 8.5, z: -16, s: 5.5 },
      { x: -5, y: 9.5, z: -25, s: 7.5 },
    ];
    cloudPositions.forEach(cp => {
      const spMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.9, depthWrite: false });
      const sp = new THREE.Sprite(spMat);
      sp.position.set(cp.x, cp.y, cp.z);
      sp.scale.set(cp.s, cp.s * 0.5, 1);
      this.scene.add(sp);
    });

    // === GROUND (grass field) ===
    const groundCanvas = document.createElement('canvas');
    groundCanvas.width = 512;
    groundCanvas.height = 512;
    const gctx = groundCanvas.getContext('2d');
    // Base green
    gctx.fillStyle = '#4a8c3f';
    gctx.fillRect(0, 0, 512, 512);
    // Grass texture noise
    for (let i = 0; i < 8000; i++) {
      const gx = Math.random() * 512;
      const gy = Math.random() * 512;
      const shade = 60 + Math.random() * 50;
      gctx.fillStyle = `rgb(${shade * 0.6}, ${shade + 40}, ${shade * 0.4})`;
      gctx.fillRect(gx, gy, 1 + Math.random() * 2, 2 + Math.random() * 4);
    }
    const grassTex = new THREE.CanvasTexture(groundCanvas);
    grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(8, 8);
    grassTex.colorSpace = THREE.SRGBColorSpace;

    const groundGeo = new THREE.PlaneGeometry(60, 60);
    const groundMat = new THREE.MeshLambertMaterial({ map: grassTex });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.4;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // === STONES ===
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8a8a7a });
    const stonePositions = [
      { x: -2.5, z: -2, s: 0.25 },
      { x: 3, z: -3, s: 0.35 },
      { x: -1, z: -4, s: 0.2 },
      { x: 4.5, z: -1.5, s: 0.15 },
      { x: -3.5, z: -3.5, s: 0.3 },
      { x: 1.5, z: -1, s: 0.12 },
      { x: -0.5, z: -2.5, s: 0.18 },
    ];
    stonePositions.forEach(sp => {
      const geo = new THREE.DodecahedronGeometry(sp.s, 1);
      // Roughen vertices a bit
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setX(i, pos.getX(i) + (Math.random() - 0.5) * sp.s * 0.3);
        pos.setY(i, pos.getY(i) + (Math.random() - 0.5) * sp.s * 0.3);
        pos.setZ(i, pos.getZ(i) + (Math.random() - 0.5) * sp.s * 0.3);
      }
      geo.computeVertexNormals();
      const mat = stoneMat.clone();
      const shade = 0.7 + Math.random() * 0.3;
      mat.color.setRGB(0.54 * shade, 0.54 * shade, 0.48 * shade);
      const stone = new THREE.Mesh(geo, mat);
      stone.position.set(sp.x, -0.4 + sp.s * 0.4, sp.z);
      stone.rotation.set(Math.random(), Math.random(), Math.random());
      this.scene.add(stone);
    });

    // === TREES ===
    const treePositions = [
      { x: -6, z: -8, trunkH: 1.8, crownR: 1.5 },
      { x: 7, z: -10, trunkH: 2.2, crownR: 1.8 },
      { x: -4, z: -12, trunkH: 2.0, crownR: 1.6 },
      { x: 10, z: -7, trunkH: 1.5, crownR: 1.2 },
      { x: -9, z: -6, trunkH: 1.6, crownR: 1.3 },
      { x: 3, z: -14, trunkH: 2.5, crownR: 2.0 },
      { x: -2, z: -16, trunkH: 2.0, crownR: 1.7 },
      { x: 12, z: -12, trunkH: 1.8, crownR: 1.4 },
    ];
    treePositions.forEach(tp => {
      const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, tp.trunkH, 6);
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4226 });
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(tp.x, -0.4 + tp.trunkH / 2, tp.z);
      this.scene.add(trunk);

      // Layered crown for a fuller look
      const crownShades = [0x2d7a2d, 0x3a8f3a, 0x267326];
      for (let i = 0; i < 3; i++) {
        const crownGeo = new THREE.SphereGeometry(tp.crownR * (1 - i * 0.15), 8, 6);
        const crownMat = new THREE.MeshLambertMaterial({ color: crownShades[i] });
        const crown = new THREE.Mesh(crownGeo, crownMat);
        const offsetX = (Math.random() - 0.5) * tp.crownR * 0.4;
        const offsetZ = (Math.random() - 0.5) * tp.crownR * 0.4;
        crown.position.set(tp.x + offsetX, -0.4 + tp.trunkH + tp.crownR * 0.5 + i * 0.2, tp.z + offsetZ);
        this.scene.add(crown);
      }
    });

    // === Fog for depth ===
    this.scene.fog = new THREE.FogExp2(0xc8e6ff, 0.02);
  }

  _initEvents() {
    if (!this.interactive) return; // no drag on non-interactive viewers

    const canvas = this.renderer.domElement;

    canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.momentum = 0;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStartX;
      this.momentum = dx * 0.01;
      this.modelRotationY += dx * 0.01;
      this.dragStartX = e.clientX;
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Touch support
    canvas.addEventListener('touchstart', (e) => {
      this.isDragging = true;
      this.dragStartX = e.touches[0].clientX;
      this.momentum = 0;
    });

    canvas.addEventListener('touchmove', (e) => {
      if (!this.isDragging) return;
      const dx = e.touches[0].clientX - this.dragStartX;
      this.momentum = dx * 0.01;
      this.modelRotationY += dx * 0.01;
      this.dragStartX = e.touches[0].clientX;
    });

    canvas.addEventListener('touchend', () => {
      this.isDragging = false;
    });
  }

  _animate() {
    this.animId = requestAnimationFrame(() => this._animate());

    this.clock.getDelta();

    if (this.model) {
      if (!this.isDragging) {
        this.momentum *= 0.95;
        this.modelRotationY += this.momentum;
      }
      this.model.rotation.y = this.modelRotationY;
    }

    this.renderer.render(this.scene, this.camera);
  }

  async loadGLTF(filePath) {
    if (!this.loader) throw new Error('GLTFLoader not available');
    return new Promise((resolve, reject) => {
      const url = `file://${filePath}`;
      this.loader.load(url, resolve, undefined, reject);
    });
  }

  async show(cybermonId, opts = {}) {
    const { rimColor = '#00aaff' } = opts;

    // Set rim light color
    this.rimLight.color.set(rimColor);

    // Remove old model
    if (this.model) {
      this.scene.remove(this.model);
      this.model = null;
    }

    // Check for GLB file
    const path = require('path');
    const fs = require('fs');
    const assetsBase = window.__cyberclawAssetsPath || path.join(__dirname, 'assets', 'cybermons');
    const glbPath = path.join(assetsBase, `${cybermonId}.glb`);

    if (!fs.existsSync(glbPath)) {
      console.warn(`No GLB for ${cybermonId} at ${glbPath}`);
      return;
    }

    try {
      const gltf = _gltfCache[cybermonId] || await this.loadGLTF(glbPath);
      _gltfCache[cybermonId] = gltf;

      // Clone the scene so we can reuse the cache
      this.model = gltf.scene.clone();

      // Fix materials + remove ground planes/shadow discs
      const meshesToHide = [];
      this.model.traverse(child => {
        if (child.isMesh) {
          const name = (child.name || '').toLowerCase();
          // Hide known ground/platform objects
          if (name.includes('plane') || name.includes('ground') || name.includes('shadow') ||
              name.includes('circle') || name.includes('disc') || name.includes('platform')) {
            meshesToHide.push(child);
            return;
          }
          // Also hide very flat meshes (ground planes without names)
          if (child.geometry) {
            child.geometry.computeBoundingBox();
            const bb = child.geometry.boundingBox;
            if (bb) {
              const sy = bb.max.y - bb.min.y;
              const sx = bb.max.x - bb.min.x;
              const sz = bb.max.z - bb.min.z;
              if (sy < 0.01 && sx > 0.3 && sz > 0.3) {
                meshesToHide.push(child);
                return;
              }
            }
          }
        }
        if (child.isMesh && child.material) {
          const mat = child.material.clone();
          // If base color is black but emissive has color, swap them
          if (mat.color && mat.emissive &&
              mat.color.r + mat.color.g + mat.color.b < 0.1 &&
              mat.emissive.r + mat.emissive.g + mat.emissive.b > 0.1) {
            mat.color.copy(mat.emissive);
            mat.emissive.set(0, 0, 0);
          }
          // Boost saturation slightly for vibrant toon look
          if (mat.color) {
            mat.color.r = Math.min(1, mat.color.r * 1.2);
            mat.color.g = Math.min(1, mat.color.g * 1.2);
            mat.color.b = Math.min(1, mat.color.b * 1.2);
          }
          mat.roughness = 0.7;
          mat.metalness = 0.05;
          child.material = mat;
        }
      });

      // Remove ground planes/platforms
      meshesToHide.forEach(m => { m.visible = false; });

      // Auto-scale to fit
      const box = new THREE.Box3().setFromObject(this.model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 1.3 / maxDim; // ~33% smaller
      this.model.scale.setScalar(scale);

      // Center horizontally, sit lower
      box.setFromObject(this.model);
      const center = box.getCenter(new THREE.Vector3());
      this.model.position.sub(center);
      this.model.position.y = -0.4; // move down

      this.modelRotationY = 0;
      this.scene.add(this.model);
    } catch (e) {
      console.error(`Failed to load GLB for ${cybermonId}:`, e);
    }
  }

  clear() {
    if (this.model) {
      this.scene.remove(this.model);
      this.model = null;
    }
  }

  dispose() {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.resizeObs) this.resizeObs.disconnect();
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement?.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
    this.clear();
  }
}

// Export for bundled usage
window.CybermonViewer = CybermonViewer;
