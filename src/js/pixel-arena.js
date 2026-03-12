/* ============================================================
   PixelArena — Shared 2D arena where all companions roam
   ============================================================ */

const _path = require('path');
const _fs = require('fs');

class PixelArena {
  constructor(containerId) {
    this.container = typeof containerId === 'string'
      ? document.getElementById(containerId)
      : containerId;
    if (!this.container) return;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pixel-arena-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    this.companions = []; // { id, sprite, x, y, vx, vy, state, stateTimer, direction, pixelCompanionId }
    this.focusedId = null;
    this.animId = null;
    this.lastTime = 0;

    // Ground color
    this.groundColor = '#1a2a1a';
    this.grassPatches = [];

    this._resize();
    this._generateGrass();
    this._initResize();
    this._animate();
  }

  _resize() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 400;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
  }

  _initResize() {
    this.resizeObs = new ResizeObserver(() => {
      this._resize();
      this._generateGrass();
    });
    this.resizeObs.observe(this.container);
  }

  _generateGrass() {
    this.grassPatches = [];
    const count = Math.floor((this.width * this.height) / 800);
    for (let i = 0; i < count; i++) {
      this.grassPatches.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        size: 2 + Math.random() * 4,
        shade: Math.random() * 0.3
      });
    }
  }

  async addCompanion(agentId, pixelCompanionId, startX, startY) {
    // Check if already added
    if (this.companions.find(c => c.id === agentId)) return;

    const catalog = loadPixelCatalog();
    const compData = catalog.companions.find(c => c.id === pixelCompanionId);
    if (!compData) return;

    // Load sprite images for all animations
    const basePath = _path.join(__dirname, 'assets', 'pixel-companions', compData.folder);
    const images = {};

    for (const [animName, animData] of Object.entries(compData.animations)) {
      const imgPath = _path.join(basePath, animData.file);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `file://${imgPath}`;
      });
      images[animName] = { img, frames: animData.frames, cols: animData.cols || animData.frames };
    }

    const comp = {
      id: agentId,
      pixelCompanionId,
      data: compData,
      images,
      x: startX || Math.random() * (this.width - 100) + 50,
      y: startY || Math.random() * (this.height - 100) + 50,
      vx: 0,
      vy: 0,
      direction: Math.floor(Math.random() * 4), // 0=down, 1=left, 2=right, 3=up
      animation: 'idle',
      frame: 0,
      frameTimer: 0,
      frameSpeed: 150, // ms per frame
      state: 'idle', // idle, walk, run
      stateTimer: 2000 + Math.random() * 3000,
      scale: 3,
      focused: false,
    };

    this.companions.push(comp);
  }

  removeCompanion(agentId) {
    this.companions = this.companions.filter(c => c.id !== agentId);
  }

  setFocused(agentId) {
    this.focusedId = agentId;
    this.companions.forEach(c => {
      c.focused = (c.id === agentId);
    });
  }

  _updateCompanion(comp, dt) {
    // Frame animation
    comp.frameTimer += dt;
    const animData = comp.images[comp.animation];
    if (animData && comp.frameTimer >= comp.frameSpeed) {
      comp.frameTimer = 0;
      comp.frame = (comp.frame + 1) % animData.frames;
    }

    // AI state machine
    comp.stateTimer -= dt;
    if (comp.stateTimer <= 0) {
      // Pick new state
      const roll = Math.random();
      if (roll < 0.4) {
        comp.state = 'idle';
        comp.animation = 'idle';
        comp.vx = 0;
        comp.vy = 0;
        comp.stateTimer = 2000 + Math.random() * 4000;
      } else if (roll < 0.8) {
        comp.state = 'walk';
        comp.animation = 'walk';
        comp.direction = Math.floor(Math.random() * 4);
        const speed = 0.03 + Math.random() * 0.02;
        const dirs = [[0, 1], [-1, 0], [1, 0], [0, -1]]; // down, left, right, up
        comp.vx = dirs[comp.direction][0] * speed;
        comp.vy = dirs[comp.direction][1] * speed;
        comp.stateTimer = 1500 + Math.random() * 3000;
      } else {
        comp.state = 'run';
        comp.animation = comp.images['run'] ? 'run' : 'walk';
        comp.direction = Math.floor(Math.random() * 4);
        const speed = 0.06 + Math.random() * 0.03;
        const dirs = [[0, 1], [-1, 0], [1, 0], [0, -1]];
        comp.vx = dirs[comp.direction][0] * speed;
        comp.vy = dirs[comp.direction][1] * speed;
        comp.stateTimer = 800 + Math.random() * 1500;
      }
      comp.frame = 0;
      comp.frameTimer = 0;
    }

    // Move
    comp.x += comp.vx * dt;
    comp.y += comp.vy * dt;

    // Bounds
    const fw = (comp.data.frameSize[0] || 32) * comp.scale;
    const fh = (comp.data.frameSize[1] || 32) * comp.scale;
    const margin = 10;

    if (comp.x < margin) { comp.x = margin; comp.vx = Math.abs(comp.vx); comp.direction = 2; }
    if (comp.x > this.width - fw - margin) { comp.x = this.width - fw - margin; comp.vx = -Math.abs(comp.vx); comp.direction = 1; }
    if (comp.y < margin) { comp.y = margin; comp.vy = Math.abs(comp.vy); comp.direction = 0; }
    if (comp.y > this.height - fh - margin) { comp.y = this.height - fh - margin; comp.vy = -Math.abs(comp.vy); comp.direction = 3; }
  }

  _drawCompanion(comp) {
    const animData = comp.images[comp.animation] || comp.images['idle'];
    if (!animData) return;

    const [fw, fh] = comp.data.frameSize;
    const cols = animData.cols || animData.frames;
    const row = comp.direction; // 0=down, 1=left, 2=right, 3=up
    const col = comp.frame % cols;

    const sx = col * fw;
    const sy = row * fh;
    const dw = fw * comp.scale;
    const dh = fh * comp.scale;

    // Draw shadow
    this.ctx.fillStyle = 'rgba(0,0,0,0.2)';
    this.ctx.beginPath();
    this.ctx.ellipse(comp.x + dw / 2, comp.y + dh - 2, dw * 0.4, 4, 0, 0, Math.PI * 2);
    this.ctx.fill();

    // Draw sprite
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(animData.img, sx, sy, fw, fh, comp.x, comp.y, dw, dh);

    // Draw name label
    if (comp.focused) {
      this.ctx.fillStyle = '#ff9900';
      this.ctx.font = 'bold 12px Orbitron, monospace';
    } else {
      this.ctx.fillStyle = 'rgba(255,255,255,0.7)';
      this.ctx.font = '10px Orbitron, monospace';
    }
    this.ctx.textAlign = 'center';
    const label = comp._name || comp.id.split('-').pop();
    this.ctx.fillText(label, comp.x + dw / 2, comp.y - 6);
  }

  _drawGround() {
    // Base ground
    this.ctx.fillStyle = this.groundColor;
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Grass patches
    for (const g of this.grassPatches) {
      const green = Math.floor(40 + g.shade * 30);
      this.ctx.fillStyle = `rgb(${10 + g.shade * 10}, ${green}, ${10 + g.shade * 5})`;
      this.ctx.fillRect(g.x, g.y, g.size, g.size * 0.6);
    }

    // Grid lines (subtle)
    this.ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    this.ctx.lineWidth = 1;
    for (let x = 0; x < this.width; x += 48) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.height);
      this.ctx.stroke();
    }
    for (let y = 0; y < this.height; y += 48) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.width, y);
      this.ctx.stroke();
    }
  }

  _animate() {
    const now = performance.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    // Update all companions
    for (const comp of this.companions) {
      this._updateCompanion(comp, dt);
    }

    // Draw
    this._drawGround();

    // Sort by Y for depth ordering
    const sorted = [...this.companions].sort((a, b) => a.y - b.y);
    for (const comp of sorted) {
      this._drawCompanion(comp);
    }

    this.animId = requestAnimationFrame(() => this._animate());
  }

  dispose() {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.resizeObs) this.resizeObs.disconnect();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.companions = [];
  }
}

// Export globally
window.PixelArena = PixelArena;
