/* ============================================================
   PixelSprite — Animated pixel companion renderer
   Loads sprite sheets, animates frames on a canvas
   ============================================================ */

const _path = require('path');
const _fs = require('fs');

try { _fs.appendFileSync(_path.join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] pixel-sprite.js loaded OK\n`); } catch {}
let pixelCatalog = null;

function loadPixelCatalog() {
  // v3.1.27: ALWAYS re-read the catalog file. We used to cache
  // it at module level (`pixelCatalog`), but that cached the
  // OLD version (no iconFile field) across code updates. The
  // catalog is tiny (<4KB) and read from disk on every call,
  // so the cost is negligible compared to the bug we just hit.
  const candidates = [];
  if (window._assetsDir) candidates.push(_path.join(window._assetsDir, 'companions', 'catalog.json'));
  if (typeof __dirname === 'string' && __dirname) {
    candidates.push(_path.join(__dirname, '..', 'assets', 'companions', 'catalog.json'));
    candidates.push(_path.join(__dirname, 'assets', 'companions', 'catalog.json'));
  }
  if (typeof process !== 'undefined' && process.cwd) {
    candidates.push(_path.join(process.cwd(), 'src', 'assets', 'companions', 'catalog.json'));
  }
  for (const catalogPath of candidates) {
    try {
      const fresh = JSON.parse(_fs.readFileSync(catalogPath, 'utf-8'));
      try { _fs.appendFileSync(_path.join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] loadPixelCatalog OK: ${catalogPath} (${fresh.companions.length} sprites)\n`); } catch {}
      pixelCatalog = fresh;
      return fresh;
    } catch (_) { /* try next */ }
  }
  try { _fs.appendFileSync(_path.join(require('os').homedir(), '.openclaw', 'cyberclaw', 'debug.log'), `[${new Date().toISOString()}] loadPixelCatalog FAIL. __dirname=${typeof __dirname} cwd=${process?.cwd()} candidates=${JSON.stringify(candidates)}\n`); } catch {}
  console.error('[PixelSprite] Failed to load catalog from any candidate:', candidates);
  // Fall back to the cached version if we have one (from an
  // earlier successful read in this session), then to empty.
  if (pixelCatalog) return pixelCatalog;
  pixelCatalog = { companions: [] };
  return pixelCatalog;
}

class PixelSprite {
  /**
   * @param {HTMLElement} container — DOM element to render into
   * @param {Object} opts — { scale: 3, direction: 0, animation: 'idle' }
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.scale = opts.scale || 4;
    this.direction = opts.direction || 0; // 0=down, 1=left, 2=right, 3=up
    this.currentAnim = opts.animation || 'idle';
    this.frame = 0;
    this.tickCount = 0;
    this.companionId = null;
    this.companionData = null;
    this.images = {};       // { animName: Image }
    this.canvas = null;
    this.ctx = null;
    this._raf = null;
    this._disposed = false;

    this._initCanvas();
  }

  _initCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pixel-sprite-canvas';
    this.canvas.style.imageRendering = 'pixelated';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.container.innerHTML = '';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
  }

  async show(companionId) {
    const catalog = loadPixelCatalog();
    const data = catalog.companions.find(c => c.id === companionId);
    if (!data) {
      console.error('[PixelSprite] Companion not found:', companionId);
      return;
    }

    this.companionId = companionId;
    this.companionData = data;
    this.frame = 0;
    this.tickCount = 0;

    // Preload all animation sprite sheets. Use the same candidate
    // resolution as loadPixelCatalog — see comment there. We try
    // each candidate until the sprite PNG loads.
    const candidates = [];
    if (window._assetsDir) candidates.push(_path.join(window._assetsDir, 'companions', data.folder));
    if (typeof __dirname === 'string' && __dirname) {
      candidates.push(_path.join(__dirname, '..', 'assets', 'companions', data.folder));
      candidates.push(_path.join(__dirname, 'assets', 'companions', data.folder));
    }
    if (typeof process !== 'undefined' && process.cwd) {
      candidates.push(_path.join(process.cwd(), 'src', 'assets', 'companions', data.folder));
    }
    let basePath = null;
    for (const candidate of candidates) {
      try { _fs.accessSync(_path.join(candidate, data.animations.idle.file)); basePath = candidate; break; } catch (_) {}
    }
    if (!basePath) {
      console.error('[PixelSprite] Could not find sprite folder in any candidate:', candidates);
      return;
    }
    const loadPromises = [];

    for (const [animName, animData] of Object.entries(data.animations)) {
      const imgPath = _path.join(basePath, animData.file);
      loadPromises.push(this._loadImage(animName, imgPath));
    }

    await Promise.all(loadPromises);

    // Set canvas size
    const [fw, fh] = data.frameSize;
    this.canvas.width = fw * this.scale;
    this.canvas.height = fh * this.scale;

    // Start animation loop
    this._startLoop();
  }

  _loadImage(name, filePath) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.images[name] = img;
        resolve();
      };
      img.onerror = () => {
        console.warn('[PixelSprite] Failed to load:', filePath);
        resolve();
      };
      img.src = `file://${filePath}`;
    });
  }

  setAnimation(animName) {
    if (animName !== this.currentAnim && this.companionData?.animations[animName]) {
      this.currentAnim = animName;
      this.frame = 0;
      this.tickCount = 0;
    }
  }

  setDirection(dir) {
    this.direction = Math.max(0, Math.min(3, dir));
  }

  _startLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    const loop = () => {
      if (this._disposed) return;
      this._tick();
      this._draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _tick() {
    if (!this.companionData) return;
    const anim = this.companionData.animations[this.currentAnim];
    if (!anim) return;

    this.tickCount++;
    if (this.tickCount >= anim.speed) {
      this.tickCount = 0;
      this.frame = (this.frame + 1) % anim.frames;
    }
  }

  _draw() {
    if (!this.companionData || !this.ctx) return;
    const anim = this.companionData.animations[this.currentAnim];
    const img = this.images[this.currentAnim];
    if (!anim || !img) return;

    const [fw, fh] = this.companionData.frameSize;
    const sx = this.frame * fw;
    const sy = this.direction * fh;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(
      img,
      sx, sy, fw, fh,           // source rect
      0, 0, fw * this.scale, fh * this.scale  // dest rect (scaled)
    );
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.images = {};
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}

// Export
window.PixelSprite = PixelSprite;
window.loadPixelCatalog = loadPixelCatalog;
