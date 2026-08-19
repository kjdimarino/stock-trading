/* =========================================================================
   Canvas charting engine — candlesticks, line/area, volume, crosshair.

   No charting library: everything is drawn by hand so the app stays a single
   offline file. Two stacked canvases keep interaction cheap — the price series
   redraws only when data changes, while the crosshair repaints on its own
   layer every mousemove.
   ========================================================================= */
(function (PT) {
  'use strict';

  const U = PT.util;

  /* ------------------------------------------------------------ utilities */

  /** Nice-number axis steps: 1, 2, 5 × 10^n. */
  function niceNum(range, round) {
    if (!(range > 0)) return 1;
    const exp = Math.floor(Math.log10(range));
    const f = range / Math.pow(10, exp);
    let nf;
    if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }

  /** Evenly spaced "nice" ticks covering [lo, hi]. */
  function ticks(lo, hi, count) {
    if (!(hi > lo) || !isFinite(lo) || !isFinite(hi)) return [lo];

    const build = (step) => {
      const out = [];
      if (!(step > 0)) return out;
      const start = Math.ceil(lo / step) * step;
      for (let v = start, i = 0; v <= hi + step * 1e-9 && i < 200; v += step, i++) out.push(v);
      return out;
    };

    let step = niceNum(niceNum(hi - lo, false) / Math.max(1, count - 1), true);
    let out = build(step);
    /*
     * Rounding to a "nice" step can overshoot a narrow range badly enough to
     * leave one gridline or none — visible on sub-penny assets. Halve until the
     * axis is legible again.
     */
    for (let guard = 0; out.length < 3 && guard < 5; guard++) {
      step /= 2;
      out = build(step);
    }
    return out.length ? out : [lo, hi];
  }

  /**
   * Decimals needed so adjacent ticks read as distinct values. A whole-number
   * step needs none — "$100,000.0" is noise, "$100,000" is a price.
   */
  function axisDecimals(step) {
    if (!(step > 0)) return 2;
    if (step >= 1) return 0;
    return U.clamp(Math.ceil(-Math.log10(step)), 0, 8);
  }

  const fmtAxis = (v, dp) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

  const TIME_FMT = {
    '1s': { minute: '2-digit', second: '2-digit' },
    '5s': { minute: '2-digit', second: '2-digit' },
    '15s': { hour: 'numeric', minute: '2-digit', second: '2-digit' },
    '1m': { hour: 'numeric', minute: '2-digit' },
    '5m': { hour: 'numeric', minute: '2-digit' },
    '15m': { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    '1h': { month: 'short', day: 'numeric', hour: 'numeric' },
    '1D': { month: 'short', day: 'numeric' },
    '1W': { month: 'short', year: '2-digit' },
  };
  const fmtTimeFor = (tf, ms) => new Intl.DateTimeFormat('en-US', TIME_FMT[tf] || TIME_FMT['1D']).format(new Date(ms));

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /* ============================== PriceChart ============================== */

  class PriceChart {
    constructor(container) {
      this.el = container;
      this.bars = [];
      this.tf = '5m';
      this.mode = 'candle';
      this.showVolume = true;
      this.hover = null;       // hovered bar index
      this.dpr = 1;
      this.raf = 0;
      this.onHover = null;

      this.base = document.createElement('canvas');
      this.over = document.createElement('canvas');
      this.over.className = 'overlay';
      container.appendChild(this.base);
      container.appendChild(this.over);

      this.bctx = this.base.getContext('2d');
      this.octx = this.over.getContext('2d');

      this.pad = { t: 14, r: 66, b: 24, l: 8 };

      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      container.addEventListener('mousemove', this._onMove);
      container.addEventListener('mouseleave', this._onLeave);
      container.addEventListener('touchmove', this._onMove, { passive: true });
      container.addEventListener('touchend', this._onLeave);

      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(container);
      this.resize();
    }

    destroy() {
      this.ro.disconnect();
      this.el.removeEventListener('mousemove', this._onMove);
      this.el.removeEventListener('mouseleave', this._onLeave);
      cancelAnimationFrame(this.raf);
      this.base.remove();
      this.over.remove();
    }

    /* ---------------------------------------------------------- geometry */

    resize() {
      const r = this.el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.dpr = Math.min(3, window.devicePixelRatio || 1);
      this.w = r.width;
      this.h = r.height;
      for (const c of [this.base, this.over]) {
        c.width = Math.round(r.width * this.dpr);
        c.height = Math.round(r.height * this.dpr);
      }
      // Draw in CSS pixels; the transform handles the device ratio.
      this.bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.draw();
    }

    setData(bars, tf) {
      this.bars = Array.isArray(bars) ? bars : [];
      if (tf) this.tf = tf;
      this.draw();
      /*
       * The newest bar mutates in place as ticks arrive, and the crosshair
       * pill re-reads it on every repaint. Re-emit the hovered bar so the
       * legend cannot drift from the pill and show two closes for one candle.
       */
      if (this.hover != null && this.onHover) {
        this.onHover(this.bars[this.hover] || null, this.hover);
      }
    }

    setMode(mode) { this.mode = mode; this.draw(); }
    setVolume(on) { this.showVolume = on; this.draw(); }

    /** Plot rectangle, excluding axes and the volume pane. */
    _plot() {
      const volH = this.showVolume ? Math.max(28, (this.h - this.pad.t - this.pad.b) * 0.18) : 0;
      const top = this.pad.t;
      const bottom = this.h - this.pad.b - volH;
      return {
        x0: this.pad.l,
        x1: this.w - this.pad.r,
        y0: top,
        y1: bottom,
        volTop: bottom + 6,
        volBottom: this.h - this.pad.b,
        volH,
        width: this.w - this.pad.l - this.pad.r,
        height: bottom - top,
      };
    }

    /** Visible price range with a little headroom, plus the volume max. */
    _range(p) {
      let lo = Infinity, hi = -Infinity, vmax = 0;
      for (const b of this.bars) {
        if (b.l < lo) lo = b.l;
        if (b.h > hi) hi = b.h;
        if (b.v > vmax) vmax = b.v;
      }
      if (!isFinite(lo) || !isFinite(hi)) return null;
      if (hi === lo) { hi = lo * 1.001 || 1; lo = lo * 0.999 || 0; }
      const padding = (hi - lo) * 0.08;
      return { lo: lo - padding, hi: hi + padding, vmax };
    }

    _barWidth(p) {
      return this.bars.length ? p.width / this.bars.length : p.width;
    }

    _xOf(i, p) {
      const bw = this._barWidth(p);
      return p.x0 + i * bw + bw / 2;
    }

    _yOf(price, p, r) {
      return p.y1 - ((price - r.lo) / (r.hi - r.lo)) * p.height;
    }

    _indexAt(clientX) {
      const p = this._plot();
      const rect = this.el.getBoundingClientRect();
      const x = clientX - rect.left;
      const bw = this._barWidth(p);
      if (bw <= 0) return null;
      const i = Math.floor((x - p.x0) / bw);
      return U.clamp(i, 0, this.bars.length - 1);
    }

    /* ------------------------------------------------------------ events */

    _onMove(ev) {
      const touch = ev.touches && ev.touches[0];
      const clientX = touch ? touch.clientX : ev.clientX;
      const i = this._indexAt(clientX);
      if (i !== this.hover) {
        this.hover = i;
        this._drawOverlay();
        if (this.onHover) this.onHover(this.bars[i] || null, i);
      }
    }

    _onLeave() {
      if (this.hover == null) return;
      this.hover = null;
      this._drawOverlay();
      if (this.onHover) this.onHover(null, null);
    }

    /* ------------------------------------------------------------- paint */

    draw() {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => { this._drawBase(); this._drawOverlay(); });
    }

    _colors() {
      return {
        up: cssVar('--dir-up', '#0ecb81'),
        down: cssVar('--dir-down', '#ff4d5e'),
        grid: cssVar('--border-subtle', 'rgba(255,255,255,.055)'),
        axis: cssVar('--text-quaternary', '#5a6478'),
        text: cssVar('--text-secondary', '#9ba6bc'),
        accent: cssVar('--accent', '#4c82f7'),
        surface: cssVar('--surface-3', '#1d222d'),
        void: cssVar('--bg-void', '#06080b'),
      };
    }

    _drawBase() {
      const ctx = this.bctx;
      if (!this.w || !this.h) return;
      ctx.clearRect(0, 0, this.w, this.h);
      const c = this._colors();
      if (!this.bars.length) return;

      const p = this._plot();
      const r = this._range(p);
      if (!r) return;
      this._r = r;

      /* grid + price axis */
      const yTicks = ticks(r.lo, r.hi, Math.max(3, Math.floor(p.height / 46)));
      const dp = axisDecimals(yTicks.length > 1 ? yTicks[1] - yTicks[0] : r.hi - r.lo);
      ctx.font = `500 10px ${cssVar('--font-sans', 'system-ui')}`;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;

      for (const v of yTicks) {
        const y = Math.round(this._yOf(v, p, r)) + 0.5; // crisp hairlines
        if (y < p.y0 - 1 || y > p.y1 + 1) continue;
        ctx.strokeStyle = c.grid;
        ctx.beginPath();
        ctx.moveTo(p.x0, y);
        ctx.lineTo(p.x1, y);
        ctx.stroke();
        ctx.fillStyle = c.axis;
        ctx.textAlign = 'left';
        ctx.fillText(fmtAxis(v, dp), p.x1 + 7, y);
      }

      /* time axis */
      const step = Math.max(1, Math.ceil(this.bars.length / Math.max(2, Math.floor(p.width / 92))));
      ctx.textAlign = 'center';
      for (let i = this.bars.length - 1; i >= 0; i -= step) {
        const x = this._xOf(i, p);
        if (x < p.x0 || x > p.x1) continue;
        ctx.strokeStyle = c.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, p.y0);
        ctx.lineTo(Math.round(x) + 0.5, p.y1);
        ctx.stroke();
        ctx.fillStyle = c.axis;
        ctx.fillText(fmtTimeFor(this.tf, this.bars[i].t), x, this.h - this.pad.b / 2);
      }

      /* volume pane */
      if (this.showVolume && r.vmax > 0) {
        const bw = this._barWidth(p);
        const w = Math.max(1, bw * 0.62);
        for (let i = 0; i < this.bars.length; i++) {
          const b = this.bars[i];
          const hgt = (b.v / r.vmax) * (p.volBottom - p.volTop);
          ctx.fillStyle = b.c >= b.o ? c.up : c.down;
          ctx.globalAlpha = 0.26;
          ctx.fillRect(this._xOf(i, p) - w / 2, p.volBottom - hgt, w, hgt);
        }
        ctx.globalAlpha = 1;
      }

      if (this.mode === 'line') this._drawLine(ctx, p, r, c);
      else this._drawCandles(ctx, p, r, c);

      this._drawLastPrice(ctx, p, r, c);
    }

    _drawCandles(ctx, p, r, c) {
      const bw = this._barWidth(p);
      const body = Math.max(1, Math.min(14, bw * 0.68));
      const thin = bw < 3;

      for (let i = 0; i < this.bars.length; i++) {
        const b = this.bars[i];
        const x = this._xOf(i, p);
        const up = b.c >= b.o;
        const color = up ? c.up : c.down;
        const yO = this._yOf(b.o, p, r);
        const yC = this._yOf(b.c, p, r);
        const yH = this._yOf(b.h, p, r);
        const yL = this._yOf(b.l, p, r);

        if (thin) {
          // Too narrow for bodies: draw the range as a 1px stick.
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, bw * 0.8);
          ctx.beginPath();
          ctx.moveTo(x, yH);
          ctx.lineTo(x, yL);
          ctx.stroke();
          continue;
        }

        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        const wickX = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(wickX, yH);
        ctx.lineTo(wickX, yL);
        ctx.stroke();

        const top = Math.min(yO, yC);
        // A doji still needs a visible mark.
        const hgt = Math.max(1, Math.abs(yC - yO));
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x - body / 2), Math.round(top), Math.round(body), Math.round(hgt));
      }
    }

    _drawLine(ctx, p, r, c) {
      const last = this.bars[this.bars.length - 1];
      const first = this.bars[0];
      const rising = last.c >= first.c;
      const stroke = rising ? c.up : c.down;

      ctx.beginPath();
      for (let i = 0; i < this.bars.length; i++) {
        const x = this._xOf(i, p);
        const y = this._yOf(this.bars[i].c, p, r);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }

      // Gradient fill under the line, clipped to the plot area.
      const area = ctx.createLinearGradient(0, p.y0, 0, p.y1);
      area.addColorStop(0, rising ? 'rgba(14,203,129,.22)' : 'rgba(255,77,94,.22)');
      area.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.lineTo(this._xOf(this.bars.length - 1, p), p.y1);
      ctx.lineTo(this._xOf(0, p), p.y1);
      ctx.closePath();
      ctx.fillStyle = area;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      for (let i = 0; i < this.bars.length; i++) {
        const x = this._xOf(i, p);
        const y = this._yOf(this.bars[i].c, p, r);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    _drawLastPrice(ctx, p, r, c) {
      const last = this.bars[this.bars.length - 1];
      if (!last) return;
      const y = this._yOf(last.c, p, r);
      if (y < p.y0 || y > p.y1) return;
      const up = last.c >= last.o;
      const color = up ? c.up : c.down;

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(p.x0, Math.round(y) + 0.5);
      ctx.lineTo(p.x1, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();

      // Price pill on the axis.
      const dp = last.c < 1 ? 6 : last.c < 100 ? 3 : 2;
      const text = fmtAxis(last.c, dp);
      ctx.font = `600 10px ${cssVar('--font-sans', 'system-ui')}`;
      const w = ctx.measureText(text).width + 12;
      ctx.fillStyle = color;
      const px = p.x1 + 3;
      const py = U.clamp(y - 8, p.y0, p.y1 - 16);
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(px, py, Math.min(w, this.pad.r - 5), 16, 3);
        ctx.fill();
      } else {
        ctx.fillRect(px, py, Math.min(w, this.pad.r - 5), 16);
      }
      ctx.fillStyle = up ? '#032015' : '#1e0206';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, px + 6, py + 8);
    }

    _drawOverlay() {
      const ctx = this.octx;
      if (!this.w || !this.h) return;
      ctx.clearRect(0, 0, this.w, this.h);
      if (this.hover == null || !this.bars.length || !this._r) return;

      const c = this._colors();
      const p = this._plot();
      const r = this._r;
      const b = this.bars[this.hover];
      if (!b) return;

      const x = Math.round(this._xOf(this.hover, p)) + 0.5;
      const y = Math.round(this._yOf(b.c, p, r)) + 0.5;

      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = cssVar('--text-quaternary', '#5a6478');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, p.y0); ctx.lineTo(x, this.h - this.pad.b);
      ctx.moveTo(p.x0, y); ctx.lineTo(p.x1, y);
      ctx.stroke();
      ctx.restore();

      ctx.font = `600 10px ${cssVar('--font-sans', 'system-ui')}`;
      ctx.textBaseline = 'middle';

      /* price pill */
      const dp = b.c < 1 ? 6 : b.c < 100 ? 3 : 2;
      const priceTxt = fmtAxis(b.c, dp);
      const pw = Math.min(ctx.measureText(priceTxt).width + 12, this.pad.r - 5);
      const py = U.clamp(y - 8, p.y0, p.y1 - 16);
      ctx.fillStyle = cssVar('--surface-4', '#262c38');
      ctx.fillRect(p.x1 + 3, py, pw, 16);
      ctx.fillStyle = cssVar('--text-primary', '#e6eaf2');
      ctx.textAlign = 'left';
      ctx.fillText(priceTxt, p.x1 + 9, py + 8);

      /* time pill */
      const timeTxt = fmtTimeFor(this.tf, b.t);
      const tw = ctx.measureText(timeTxt).width + 14;
      const tx = U.clamp(x - tw / 2, p.x0, p.x1 - tw);
      ctx.fillStyle = cssVar('--surface-4', '#262c38');
      ctx.fillRect(tx, this.h - this.pad.b + 2, tw, 16);
      ctx.fillStyle = cssVar('--text-primary', '#e6eaf2');
      ctx.textAlign = 'center';
      ctx.fillText(timeTxt, tx + tw / 2, this.h - this.pad.b + 10);
    }
  }

  /* ============================= EquityChart ============================== */

  /**
   * Two equity curves on one axis — the human portfolio against the AI's.
   * Series are sampled at different instants, so both are resampled onto a
   * shared time grid before drawing.
   */
  class EquityChart {
    constructor(container) {
      this.el = container;
      this.series = [];
      this.canvas = document.createElement('canvas');
      container.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.hover = null;
      this.pad = { t: 12, r: 62, b: 22, l: 8 };

      this._onMove = (ev) => {
        const rect = this.el.getBoundingClientRect();
        this.hover = ev.clientX - rect.left;
        this.draw();
      };
      this._onLeave = () => { this.hover = null; this.draw(); };
      container.addEventListener('mousemove', this._onMove);
      container.addEventListener('mouseleave', this._onLeave);

      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(container);
      this.resize();
    }

    destroy() {
      this.ro.disconnect();
      this.el.removeEventListener('mousemove', this._onMove);
      this.el.removeEventListener('mouseleave', this._onLeave);
      this.canvas.remove();
    }

    resize() {
      const r = this.el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      this.w = r.width; this.h = r.height;
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.canvas.style.width = r.width + 'px';
      this.canvas.style.height = r.height + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    /** series: [{ name, color, points: [{t, e}] }] */
    setSeries(series) { this.series = series || []; this.draw(); }

    draw() {
      const ctx = this.ctx;
      if (!this.w || !this.h) return;
      ctx.clearRect(0, 0, this.w, this.h);

      const withData = this.series.filter((s) => s.points && s.points.length > 1);
      if (!withData.length) {
        ctx.fillStyle = cssVar('--text-quaternary', '#5a6478');
        ctx.font = `500 11px ${cssVar('--font-sans', 'system-ui')}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Equity curve appears once trading begins', this.w / 2, this.h / 2);
        return;
      }

      let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const s of withData) {
        for (const pt of s.points) {
          if (pt.t < tMin) tMin = pt.t;
          if (pt.t > tMax) tMax = pt.t;
          if (pt.e < vMin) vMin = pt.e;
          if (pt.e > vMax) vMax = pt.e;
        }
      }
      if (!(tMax > tMin)) tMax = tMin + 1;
      if (vMax === vMin) { vMax = vMin * 1.001 || 1; vMin = vMin * 0.999 || 0; }
      const padV = (vMax - vMin) * 0.1;
      vMin -= padV; vMax += padV;

      const x0 = this.pad.l, x1 = this.w - this.pad.r;
      const y0 = this.pad.t, y1 = this.h - this.pad.b;
      const X = (t) => x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);
      const Y = (v) => y1 - ((v - vMin) / (vMax - vMin)) * (y1 - y0);

      const c = { grid: cssVar('--border-subtle', 'rgba(255,255,255,.055)'), axis: cssVar('--text-quaternary', '#5a6478') };
      ctx.font = `500 10px ${cssVar('--font-sans', 'system-ui')}`;
      ctx.textBaseline = 'middle';

      const yT = ticks(vMin, vMax, Math.max(3, Math.floor((y1 - y0) / 42)));
      const dp = axisDecimals(yT.length > 1 ? yT[1] - yT[0] : vMax - vMin);
      for (const v of yT) {
        const y = Math.round(Y(v)) + 0.5;
        if (y < y0 - 1 || y > y1 + 1) continue;
        ctx.strokeStyle = c.grid;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillStyle = c.axis;
        ctx.textAlign = 'left';
        ctx.fillText('$' + fmtAxis(v, dp), x1 + 6, y);
      }

      // Time labels at the ends.
      ctx.fillStyle = c.axis;
      ctx.textAlign = 'left';
      ctx.fillText(U.fmtDateTime(tMin), x0 + 2, this.h - this.pad.b / 2);
      ctx.textAlign = 'right';
      ctx.fillText(U.fmtDateTime(tMax), x1, this.h - this.pad.b / 2);

      for (const s of withData) {
        ctx.beginPath();
        s.points.forEach((pt, i) => {
          const x = X(pt.t), y = Y(pt.e);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.9;
        ctx.lineJoin = 'round';
        ctx.stroke();

        const lastPt = s.points[s.points.length - 1];
        ctx.beginPath();
        ctx.arc(X(lastPt.t), Y(lastPt.e), 3, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      }

      if (this.hover != null && this.hover > x0 && this.hover < x1) {
        const t = tMin + ((this.hover - x0) / (x1 - x0)) * (tMax - tMin);
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = c.axis;
        ctx.beginPath();
        ctx.moveTo(Math.round(this.hover) + 0.5, y0);
        ctx.lineTo(Math.round(this.hover) + 0.5, y1);
        ctx.stroke();
        ctx.restore();

        const rows = [];
        for (const s of withData) {
          // Nearest sample at or before the cursor.
          let best = null;
          for (const pt of s.points) { if (pt.t <= t) best = pt; else break; }
          if (best) rows.push({ name: s.name, color: s.color, v: best.e });
        }
        if (rows.length) {
          const bw = 132, bh = 16 * rows.length + 20;
          const bx = U.clamp(this.hover + 10, x0, x1 - bw);
          ctx.fillStyle = cssVar('--surface-4', '#262c38');
          ctx.globalAlpha = 0.96;
          ctx.fillRect(bx, y0 + 6, bw, bh);
          ctx.globalAlpha = 1;
          ctx.textAlign = 'left';
          ctx.fillStyle = cssVar('--text-tertiary', '#79839a');
          ctx.fillText(U.fmtDateTime(t), bx + 8, y0 + 16);
          rows.forEach((row, i) => {
            const y = y0 + 34 + i * 16;
            ctx.fillStyle = row.color;
            ctx.fillRect(bx + 8, y - 3, 6, 6);
            ctx.fillStyle = cssVar('--text-secondary', '#9ba6bc');
            ctx.fillText(row.name, bx + 20, y);
            ctx.textAlign = 'right';
            ctx.fillStyle = cssVar('--text-primary', '#e6eaf2');
            ctx.fillText(U.fmtUSD(row.v, { fixed2: true }), bx + bw - 8, y);
            ctx.textAlign = 'left';
          });
        }
      }
    }
  }

  /* ============================== Sparkline =============================== */

  /** Tiny inline SVG path for watchlist rows — cheap and crisp at 52×22. */
  function sparklinePath(values, w, h) {
    if (!values || values.length < 2) return '';
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi === lo) { hi = lo + 1; lo -= 1; }
    const n = values.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - ((values[i] - lo) / (hi - lo)) * h;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    return d;
  }

  PT.chart = { PriceChart, EquityChart, sparklinePath, ticks, niceNum, axisDecimals };
})(window.PT);
