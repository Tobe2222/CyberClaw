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
    this._initEvents();
    this._animate();
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
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

      // Fix materials — Blender toon shader exports color as emissive, not baseColor
      this.model.traverse(child => {
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
