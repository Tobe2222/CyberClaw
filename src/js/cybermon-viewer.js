/**
 * CybermonViewer — Three.js 3D companion renderer for the carousel.
 * Loads .glb models, renders them with toon shading, handles rotation on click.
 */
const THREE = require('three');
const path = require('path');
const fs = require('fs');

// GLTFLoader is ESM-only, so we inline a minimal loader
// that uses THREE.ObjectLoader for basic GLB/GLTF support
let GLTFLoader = null;

// Use dynamic import for ESM modules
async function getGLTFLoader() {
  if (GLTFLoader) return GLTFLoader;
  try {
    const module = await import('three/examples/jsm/loaders/GLTFLoader.js');
    GLTFLoader = module.GLTFLoader;
    return GLTFLoader;
  } catch (e) {
    console.warn('GLTFLoader import failed:', e.message);
    return null;
  }
}

class CybermonViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    this.models = new Map(); // cybermonId -> { scene, mixer }
    this.currentModel = null;
    this.currentId = null;
    this.isRotating = false;
    this.targetRotationY = 0;
    this.rotationVelocity = 0;

    this.init();
  }

  init() {
    const w = this.container.clientWidth || 300;
    const h = this.container.clientHeight || 300;

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(0, 0.5, 3.2);
    this.camera.lookAt(0, 0.4, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.container.appendChild(this.renderer.domElement);

    // Toon-style lighting
    // Strong directional (key)
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
    keyLight.position.set(2, 3, 2);
    this.scene.add(keyLight);

    // Soft fill
    const fillLight = new THREE.DirectionalLight(0x8899bb, 0.8);
    fillLight.position.set(-2, 1, -1);
    this.scene.add(fillLight);

    // Ambient
    const ambient = new THREE.AmbientLight(0x444455, 0.6);
    this.scene.add(ambient);

    // Rim light (colored, will change per element)
    this.rimLight = new THREE.PointLight(0x00aaff, 1.5, 10);
    this.rimLight.position.set(0, 1, -2);
    this.scene.add(this.rimLight);

    // GLTF Loader — loaded async
    this.loader = null;
    getGLTFLoader().then(Loader => {
      if (Loader) this.loader = new Loader();
    });

    // Interaction — click to rotate
    this.renderer.domElement.addEventListener('mousedown', this.onMouseDown.bind(this));
    this.renderer.domElement.addEventListener('mousemove', this.onMouseMove.bind(this));
    this.renderer.domElement.addEventListener('mouseup', this.onMouseUp.bind(this));
    this.renderer.domElement.addEventListener('wheel', this.onWheel.bind(this));

    // Touch support
    this.renderer.domElement.addEventListener('touchstart', this.onTouchStart.bind(this));
    this.renderer.domElement.addEventListener('touchmove', this.onTouchMove.bind(this));
    this.renderer.domElement.addEventListener('touchend', this.onMouseUp.bind(this));

    this.lastMouseX = 0;
    this.isDragging = false;

    // Animation loop
    this.clock = new THREE.Clock();
    this.animate();

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  onResize() {
    if (!this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  onMouseDown(e) {
    this.isDragging = true;
    this.lastMouseX = e.clientX;
    this.rotationVelocity = 0;
  }

  onMouseMove(e) {
    if (!this.isDragging || !this.currentModel) return;
    const dx = e.clientX - this.lastMouseX;
    this.currentModel.rotation.y += dx * 0.01;
    this.rotationVelocity = dx * 0.01;
    this.lastMouseX = e.clientX;
  }

  onMouseUp() {
    this.isDragging = false;
  }

  onWheel(e) {
    if (!this.currentModel) return;
    this.currentModel.rotation.y += e.deltaY * 0.003;
  }

  onTouchStart(e) {
    if (e.touches.length === 1) {
      this.isDragging = true;
      this.lastMouseX = e.touches[0].clientX;
      this.rotationVelocity = 0;
    }
  }

  onTouchMove(e) {
    if (!this.isDragging || !this.currentModel || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - this.lastMouseX;
    this.currentModel.rotation.y += dx * 0.01;
    this.rotationVelocity = dx * 0.01;
    this.lastMouseX = e.touches[0].clientX;
  }

  /**
   * Load and display a Cybermon model.
   * @param {string} cybermonId - e.g. "voltfox"
   * @param {object} options - { rimColor: 0x00aaff }
   */
  async show(cybermonId, options = {}) {
    if (!cybermonId) return;

    // Hide current
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
    }

    // Check cache
    if (this.models.has(cybermonId)) {
      const cached = this.models.get(cybermonId);
      this.currentModel = cached.scene;
      this.currentId = cybermonId;
      this.scene.add(this.currentModel);
      if (options.rimColor) this.rimLight.color.set(options.rimColor);
      return;
    }

    // Load GLB
    const glbPath = path.join(__dirname, 'assets', 'cybermons', `${cybermonId}.glb`);
    if (!fs.existsSync(glbPath)) {
      console.warn(`No GLB for ${cybermonId}, falling back to image`);
      this.showFallbackImage(cybermonId);
      return;
    }

    try {
      const gltf = await this.loadGLTF(glbPath);
      const model = gltf.scene;

      // Center and scale the model
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 2.0 / maxDim;

      model.position.sub(center);
      model.position.y += size.y * scale * 0.5;
      model.scale.setScalar(scale);

      // Apply toon-ish look: increase saturation, add outline feel
      model.traverse((child) => {
        if (child.isMesh) {
          if (child.material) {
            // Make materials a bit more vibrant for toon look
            if (child.material.color) {
              const hsl = {};
              child.material.color.getHSL(hsl);
              child.material.color.setHSL(hsl.h, Math.min(hsl.s * 1.3, 1), hsl.l);
            }
            child.material.roughness = Math.max(child.material.roughness || 0.5, 0.4);
            child.material.metalness = Math.min(child.material.metalness || 0, 0.2);
          }
        }
      });

      // Cache
      this.models.set(cybermonId, { scene: model });

      // Show
      this.currentModel = model;
      this.currentId = cybermonId;
      this.scene.add(model);

      // Rim light color
      if (options.rimColor) this.rimLight.color.set(options.rimColor);

    } catch (err) {
      console.error(`Failed to load GLB for ${cybermonId}:`, err);
      this.showFallbackImage(cybermonId);
    }
  }

  async loadGLTF(filePath) {
    // Ensure loader is ready
    if (!this.loader) {
      const Loader = await getGLTFLoader();
      if (Loader) this.loader = new Loader();
    }
    if (!this.loader) throw new Error('GLTFLoader not available');

    return new Promise((resolve, reject) => {
      const url = `file://${filePath}`;
      this.loader.load(url, resolve, undefined, reject);
    });
  }

  showFallbackImage(cybermonId) {
    // Create a plane with the PNG texture as fallback
    const imgPath = path.join(__dirname, 'assets', 'cybermons', `${cybermonId}.png`);
    if (!fs.existsSync(imgPath)) return;

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(`file://${imgPath}`, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      const geometry = new THREE.PlaneGeometry(2, 2);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
      });
      const plane = new THREE.Mesh(geometry, material);
      plane.position.set(0, 1, 0);

      if (this.currentModel) this.scene.remove(this.currentModel);
      this.currentModel = plane;
      this.currentId = cybermonId;
      this.scene.add(plane);
      this.models.set(cybermonId, { scene: plane });
    });
  }

  /**
   * Gentle idle rotation + momentum
   */
  animate() {
    requestAnimationFrame(() => this.animate());

    if (this.currentModel) {
      if (!this.isDragging) {
        // Apply momentum
        if (Math.abs(this.rotationVelocity) > 0.001) {
          this.currentModel.rotation.y += this.rotationVelocity;
          this.rotationVelocity *= 0.95; // friction
        } else {
          // Gentle idle rotation
          this.currentModel.rotation.y += 0.003;
        }

        // Gentle bob
        const time = this.clock.getElapsedTime();
        this.currentModel.position.y += Math.sin(time * 1.5) * 0.0003;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel = null;
      this.currentId = null;
    }
  }

  dispose() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
    this.models.forEach(({ scene }) => {
      scene.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      });
    });
    this.models.clear();
  }
}

module.exports = { CybermonViewer };
