/*!
 * Panoptes Card til Home Assistant  (v1.0.0)
 * https://github.com/oreskov/panoptes-card  -  MIT-licens
 *
 * Et kamerakort til go2rtc-streams (erstatter custom:webrtc-camera).
 * Kræver WebRTC Camera-integrationen (HACS, AlexxIT/WebRTC): streams hentes gennem integrationens
 * endpoint /api/webrtc/ws, så kortet også virker uden for hjemmenetværket (fx via Tailscale).
 * - HD- og SD-stream pr. kamera (WebRTC, MSE, HLS og MJPEG), HD kun hvor billedet er stort.
 * - Ét eller flere kameraer: enkelt, fokus + strip eller gitter, med karrusel og 16 skifteeffekter.
 * - Fuldskærm for hele kortet med kameraskift (pile, miniaturer, swipe, taster).
 * - PTZ-knapper, digital zoom, kamerastyring (privatliv, presets, patrulje, lys) og privatlivsdækning.
 * - Opstartsanimationer, accentfarve, kameramærker og teknisk udlæsning.
 * - Visuel editor på dansk og engelsk (efter HA's sprog).
 *
 * Indeholder kode tilpasset fra video-rtc.js i AlexxIT/WebRTC (MIT-licens).
 *
 * Filen er opdelt i afsnit:
 *   1. PanoptesPlayer     - henter og afspiller streamen
 *   2. PanoptesTile/Card  - kortet: layout, knapper, PTZ, digital zoom, effekter, fuldskærm
 *   3. PanoptesCardEditor - den visuelle editor
 *   4. Registrering       - gør kortet kendt i Home Assistant
 */
(() => {
    'use strict';

    const VERSION = '1.0.0';
    /** Frigiver et lærreds pixelhukommelse med det samme (Android WebView venter ellers længe med at rydde op). */
    const freeCv = cv => {
        try { cv.width = 0; cv.height = 0; } catch (e) { /* ignorer */ }
    };
    /** Skarphed for privatlivsanimationerne: lærredets pixeltæthed (jo højere, jo mere hukommelse). */
    const PRIVACY_QUALITY = ['low', 'normal', 'high'];
    const privacyDpr = q => q === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : 1.5);
    /** Et lærred, der frigiver sin hukommelse, når det fjernes fra siden. */
    const snapCanvas = () => {
        const cv = document.createElement('canvas');
        cv.remove = function () {
            HTMLElement.prototype.remove.call(this);
            freeCv(this);
        };
        return cv;
    };
    // Tællere til debug-visningen (koster næsten ingenting, også når debug er slået fra)
    const DBG = {t0: Date.now(), heap0: 0, prev: null, n: {connect: 0, stop: 0, reconn: 0, snap: 0, swap: 0, render: 0}};
    const DEFAULT_MODE = 'webrtc,mse,hls,mjpeg';
    const DEFAULT_MEDIA = 'video,audio';
    const DIRS = ['left', 'right', 'up', 'down'];
    const DIR_ICONS = {left: 'mdi:arrow-left', right: 'mdi:arrow-right', up: 'mdi:arrow-up', down: 'mdi:arrow-down'};

    const INTRO_COLORS = {
        ice: 'rgb(79 216 255)',
        white: '#ffffff',
        green: 'rgb(125 255 155)',
        amber: 'rgb(255 176 46)',
        red: 'rgb(255 92 92)',
        violet: 'rgb(200 140 255)',
        primary: 'var(--primary-color, #03a9f4)',
    };
    const INTRO_SPEED = {fast: 0.65, normal: 1, slow: 1.5};
    // Største bredde (px) på stillbillederne til skifteeffekter. 0 = videoens fulde opløsning.
    const STILL_SIZE = {small: 640, medium: 1280, full: 0};
    const esc = v => String(v).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
    const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
    const CONTROL_KEYS = ['privacy', 'preset', 'patrol', 'patrol_mode', 'light'];
    const PRIVACY_COVERS = ['none', 'black', 'blur', 'network', 'stream', 'radar', 'cams', 'clock'];

    /**
     * Animationer til privatlivsdækningen. Hver har init(s, w, h) og draw(g, w, h, t, dt, s, col).
     * De tegnes på et canvas i kortets farve og kører kun, når kameraet er stort og i syne.
     */
    const PRIVACY_FX = {
        network: {
            init(s, w, h) {
                const n = Math.min(70, Math.max(14, Math.round(w * h / 11000)));
                s.nodes = Array.from({length: n}, () => ({x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 16, vy: (Math.random() - 0.5) * 16}));
                s.pk = [];
                s.next = 0;
            },
            draw(g, w, h, t, dt, s, col) {
                g.clearRect(0, 0, w, h);
                const L = Math.max(110, Math.min(w, h) * 0.3);
                const N = s.nodes;
                N.forEach(n => {
                    n.x += n.vx * dt;
                    n.y += n.vy * dt;
                    if (n.x < 0 || n.x > w) n.vx *= -1;
                    if (n.y < 0 || n.y > h) n.vy *= -1;
                });
                g.strokeStyle = col;
                g.fillStyle = col;
                g.lineWidth = 1;
                for (let i = 0; i < N.length; i++) {
                    for (let j = i + 1; j < N.length; j++) {
                        const d = Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y);
                        if (d < L) {
                            g.globalAlpha = (1 - d / L) * 0.5;
                            g.beginPath();
                            g.moveTo(N[i].x, N[i].y);
                            g.lineTo(N[j].x, N[j].y);
                            g.stroke();
                        }
                    }
                }
                g.globalAlpha = 0.9;
                N.forEach(n => {
                    g.beginPath();
                    g.arc(n.x, n.y, 2, 0, 6.2832);
                    g.fill();
                });
                s.next -= dt;
                if (s.next <= 0 && N.length > 1) {
                    s.next = 0.35;
                    const a = N[Math.floor(Math.random() * N.length)];
                    let best = null;
                    let bd = L;
                    N.forEach(b => {
                        const d = Math.hypot(a.x - b.x, a.y - b.y);
                        if (b !== a && d < bd) {
                            bd = d;
                            best = b;
                        }
                    });
                    if (best) s.pk.push({a, b: best, p: 0});
                }
                s.pk = s.pk.filter(k => (k.p += dt * 1.3) < 1);
                g.globalAlpha = 1;
                g.shadowColor = col;
                g.shadowBlur = 8;
                s.pk.forEach(k => {
                    g.beginPath();
                    g.arc(k.a.x + (k.b.x - k.a.x) * k.p, k.a.y + (k.b.y - k.a.y) * k.p, 3, 0, 6.2832);
                    g.fill();
                });
                g.shadowBlur = 0;
                g.globalAlpha = 1;
            },
        },
        stream: {
            init(s, w, h, g) {
                const cols = Math.ceil(w / 16);
                s.y = Array.from({length: cols}, () => Math.random() * h);
                s.sp = Array.from({length: cols}, () => 40 + Math.random() * 100);
                g.globalAlpha = 1;
                g.fillStyle = '#05080c';
                g.fillRect(0, 0, w, h);
            },
            draw(g, w, h, t, dt, s, col) {
                g.globalAlpha = 1;
                g.fillStyle = 'rgba(5, 8, 12, 0.14)';
                g.fillRect(0, 0, w, h);
                g.font = '12px ui-monospace, Consolas, monospace';
                g.fillStyle = col;
                for (let i = 0; i < s.y.length; i++) {
                    s.y[i] += s.sp[i] * dt;
                    if (s.y[i] > h + 20) s.y[i] = -Math.random() * h * 0.4;
                    g.globalAlpha = 0.85;
                    g.fillText('0123456789ABCDEF'[Math.floor(Math.random() * 16)], i * 16, s.y[i]);
                }
                g.globalAlpha = 1;
            },
        },
        radar: {
            init(s) {
                s.blips = Array.from({length: 7}, () => ({a: Math.random() * 6.2832, r: 0.15 + Math.random() * 0.85}));
            },
            draw(g, w, h, t, dt, s, col) {
                g.clearRect(0, 0, w, h);
                const cx = w / 2;
                const cy = h / 2;
                const R = Math.min(w, h) * 0.42;
                g.strokeStyle = col;
                g.fillStyle = col;
                g.lineWidth = 1;
                g.globalAlpha = 0.25;
                for (let i = 1; i <= 3; i++) {
                    g.beginPath();
                    g.arc(cx, cy, R * i / 3, 0, 6.2832);
                    g.stroke();
                }
                g.globalAlpha = 0.15;
                g.beginPath();
                g.moveTo(cx - R, cy);
                g.lineTo(cx + R, cy);
                g.moveTo(cx, cy - R);
                g.lineTo(cx, cy + R);
                g.stroke();
                const a = (t * 0.9) % 6.2832;
                for (let k = 0; k < 40; k++) {
                    g.globalAlpha = 0.3 * (1 - k / 40);
                    g.beginPath();
                    g.moveTo(cx, cy);
                    g.arc(cx, cy, R, a - k * 0.025 - 0.03, a - k * 0.025);
                    g.closePath();
                    g.fill();
                }
                s.blips.forEach(b => {
                    const diff = (a - b.a + 6.2832) % 6.2832;
                    if (diff < 0.05 && Math.random() < 0.1) {
                        b.a = Math.random() * 6.2832;
                        b.r = 0.15 + Math.random() * 0.85;
                    }
                    g.globalAlpha = Math.max(0, 1 - diff / 2.5);
                    g.beginPath();
                    g.arc(cx + Math.cos(b.a) * R * b.r, cy + Math.sin(b.a) * R * b.r, 3, 0, 6.2832);
                    g.fill();
                });
                g.globalAlpha = 1;
            },
        },
        cams: {
            init(s, w, h) {
                s.cw = 64;
                s.ch = 40;
                s.cols = Math.ceil(w / (s.cw + 8));
                s.rows = Math.ceil(h / (s.ch + 8));
                s.ph = Array.from({length: s.cols * s.rows}, () => Math.random() * 6.2832);
                s.rec = s.ph.map(() => Math.random() < 0.16);
                s.hot = 0;
                s.next = 0;
            },
            draw(g, w, h, t, dt, s, col) {
                g.clearRect(0, 0, w, h);
                s.next -= dt;
                if (s.next <= 0) {
                    s.next = 0.7;
                    s.hot = Math.floor(Math.random() * s.ph.length);
                }
                g.strokeStyle = col;
                g.fillStyle = col;
                g.lineWidth = 1;
                for (let i = 0; i < s.ph.length; i++) {
                    const x = (i % s.cols) * (s.cw + 8) + 4;
                    const y = Math.floor(i / s.cols) * (s.ch + 8) + 4;
                    const base = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(t * 0.8 + s.ph[i]));
                    g.globalAlpha = i === s.hot ? 0.9 : base;
                    g.strokeRect(x + 0.5, y + 0.5, s.cw, s.ch);
                    g.beginPath();
                    g.arc(x + s.cw / 2, y + s.ch / 2, 4, 0, 6.2832);
                    g.stroke();
                    if (s.rec[i] && Math.sin(t * 3 + s.ph[i]) > 0) {
                        g.globalAlpha = 0.9;
                        g.fillStyle = '#ff4a4a';
                        g.beginPath();
                        g.arc(x + s.cw - 6, y + 6, 2.5, 0, 6.2832);
                        g.fill();
                        g.fillStyle = col;
                    }
                }
                g.globalAlpha = 1;
            },
        },
    };

    const FS_MODES = ['arrows', 'thumbs', 'swipe', 'keys'];
    const FS_MODES_DEFAULT = ['arrows', 'swipe', 'keys'];
    const SWITCH_FX = ['soft', 'slide', 'zoom', 'flip', 'pixel', 'cube', 'push', 'spin', 'roll', 'blur', 'glitch', 'mosaic', 'noise', 'wash', 'tint', 'ripple', 'random', 'none'];
    const STILL_FX = ['cube', 'push', 'spin', 'roll', 'blur', 'glitch', 'mosaic', 'noise', 'wash', 'tint', 'ripple'];
    const RANDOM_POOL = SWITCH_FX.filter(x => x !== 'random' && x !== 'none');
    /** Varighed i forhold til grundtiden for hver effekt. */
    const STILL_T = {cube: 1.4, push: 1.1, spin: 1.1, roll: 1.3, blur: 1.2, glitch: 1.0, mosaic: 1.4, noise: 1.0, wash: 1.3, tint: 1.5, ripple: 1.5};
    const pickFx = fx => fx === 'random' ? RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)] : fx;

    /* ---- Effekter tegnet på lærred (glitch, mosaik, støj, krusning) ---- */
    const smooth = (a, b, x) => {
        const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    };

    /** Deler et billede op i en rød, en grøn og en blå version (til farveforskydning). */
    const splitChannels = src => {
        const w = src.width;
        const h = src.height;
        const id = src.getContext('2d').getImageData(0, 0, w, h);
        return [0, 1, 2].map(ch => {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const g = c.getContext('2d');
            const o = g.createImageData(w, h);
            for (let i = 0; i < id.data.length; i += 4) {
                o.data[i + ch] = id.data[i + ch];
                o.data[i + 3] = 255;
            }
            g.putImageData(o, 0, 0);
            return c;
        });
    };

    const FX_CANVAS = {
        glitch: {
            init: (A, B) => ({ca: splitChannels(A), cb: splitChannels(B)}),
            draw(g, A, B, k, w, h, st) {
                const second = k >= 0.5;
                const ch = second ? st.cb : st.ca;
                const amp = second ? (1 - k) * 2 : k * 2;
                g.globalAlpha = 1;
                g.globalCompositeOperation = 'source-over';
                g.fillStyle = '#000';
                g.fillRect(0, 0, w, h);
                g.globalCompositeOperation = 'lighter';
                const split = Math.round(w * 0.025 * amp * amp + w * 0.003 * amp);
                let y = 0;
                while (y < h) {
                    const hh = Math.min(h - y, Math.max(2, Math.round(h * (0.015 + Math.random() * 0.1))));
                    const hit = Math.random() < 0.15 + amp * 0.65;
                    const off = hit ? Math.round((Math.random() - 0.5) * w * 0.3 * amp) : 0;
                    const sp = hit ? split : Math.round(split * 0.4);
                    g.drawImage(ch[0], 0, y, w, hh, off + sp, y, w, hh);
                    g.drawImage(ch[1], 0, y, w, hh, off, y, w, hh);
                    g.drawImage(ch[2], 0, y, w, hh, off - sp, y, w, hh);
                    y += hh;
                }
                g.globalCompositeOperation = 'source-over';
                const pal = ['#ff2bd6', '#22e6ff', '#ffe600', '#ff3b30'];
                const n = Math.round(amp * 5);
                for (let i = 0; i < n; i++) {
                    g.globalAlpha = 0.25 + Math.random() * 0.3;
                    g.fillStyle = pal[Math.floor(Math.random() * pal.length)];
                    g.fillRect(Math.random() * w, Math.random() * h, w * (0.05 + Math.random() * 0.3), h * (0.01 + Math.random() * 0.04));
                }
                g.globalAlpha = 1;
                g.fillStyle = 'rgba(0, 0, 0, 0.18)';
                for (let yy = 0; yy < h; yy += 3) g.fillRect(0, yy, w, 1);
                const f = 1 - Math.min(1, Math.abs(k - 0.5) / 0.07);
                if (f > 0) {
                    g.fillStyle = `rgba(255, 255, 255, ${0.35 * f})`;
                    g.fillRect(0, 0, w, h);
                }
            },
        },

        mosaic: {
            init(A, B, w, h, acc) {
                const cell = Math.max(24, Math.round(w / 14));
                const cols = Math.ceil(w / cell);
                const rows = Math.ceil(h / cell);
                const delay = [];
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        delay.push(0.3 * Math.random() + 0.3 * ((c / Math.max(1, cols - 1) + r / Math.max(1, rows - 1)) / 2));
                    }
                }
                return {cell, cols, rows, delay, acc};
            },
            draw(g, A, B, k, w, h, st) {
                g.globalAlpha = 1;
                g.fillStyle = '#000';
                g.fillRect(0, 0, w, h);
                const {cell, cols, rows, delay} = st;
                for (let r = 0; r < rows; r++) {
                    for (let c = 0; c < cols; c++) {
                        const x = c * cell;
                        const y = r * cell;
                        const cw = Math.min(cell, w - x);
                        const ch = Math.min(cell, h - y);
                        const p = Math.max(0, Math.min(1, (k - delay[r * cols + c]) / 0.4));
                        if (p <= 0) g.drawImage(A, x, y, cw, ch, x, y, cw, ch);
                        else if (p >= 1) g.drawImage(B, x, y, cw, ch, x, y, cw, ch);
                        else {
                            const s = Math.abs(Math.cos(p * Math.PI));
                            const dw = cw * s;
                            const dx = x + (cw - dw) / 2;
                            g.drawImage(p < 0.5 ? A : B, x, y, cw, ch, dx, y, dw, ch);
                            g.globalAlpha = 0.8 * (1 - s);
                            g.strokeStyle = st.acc;
                            g.lineWidth = 2;
                            g.strokeRect(dx + 1, y + 1, Math.max(0, dw - 2), Math.max(0, ch - 2));
                            g.globalAlpha = 1;
                        }
                    }
                }
            },
        },

        noise: {
            init() {
                const n = document.createElement('canvas');
                n.width = 160;
                n.height = 90;
                return {n, nd: n.getContext('2d').createImageData(160, 90)};
            },
            draw(g, A, B, k, w, h, st) {
                const n = smooth(0.1, 0.42, k) * (1 - smooth(0.58, 0.9, k));
                const src = k < 0.5 ? A : B;
                g.globalAlpha = 1;
                g.fillStyle = '#000';
                g.fillRect(0, 0, w, h);
                const slices = 24;
                for (let i = 0; i < slices; i++) {
                    const sy = Math.floor(i * h / slices);
                    const sh = Math.ceil(h / slices) + 1;
                    const off = n > 0.05 ? (Math.random() - 0.5) * w * 0.12 * n * n : 0;
                    g.drawImage(src, 0, sy, w, sh, off, sy, w, sh);
                }
                const d = st.nd.data;
                for (let i = 0; i < d.length; i += 4) {
                    const v = Math.random() * 255;
                    d[i] = v * 0.9;
                    d[i + 1] = v * 0.95;
                    d[i + 2] = v;
                    d[i + 3] = 255;
                }
                st.n.getContext('2d').putImageData(st.nd, 0, 0);
                g.globalAlpha = Math.min(1, n * 1.05);
                g.imageSmoothingEnabled = false;
                g.drawImage(st.n, 0, 0, w, h);
                g.imageSmoothingEnabled = true;
                g.globalAlpha = 1;
                g.fillStyle = `rgba(0, 0, 0, ${0.12 + 0.2 * n})`;
                for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
                const by = ((k * 2.2) % 1) * h;
                const gr = g.createLinearGradient(0, by - h * 0.08, 0, by + h * 0.08);
                gr.addColorStop(0, 'rgba(255, 255, 255, 0)');
                gr.addColorStop(0.5, `rgba(255, 255, 255, ${0.18 * n + 0.04})`);
                gr.addColorStop(1, 'rgba(255, 255, 255, 0)');
                g.fillStyle = gr;
                g.fillRect(0, by - h * 0.08, w, h * 0.16);
            },
        },

        ripple: {
            init: (A, B, w, h, acc) => ({acc}),
            draw(g, A, B, k, w, h, st) {
                g.globalAlpha = 1;
                g.fillStyle = '#000';
                g.fillRect(0, 0, w, h);
                const amp = Math.sin(Math.PI * k) * w * 0.045;
                const s = smooth(0.3, 0.7, k);
                const phase = k * 14;
                const pass = (src, alpha) => {
                    if (alpha <= 0.01) return;
                    g.globalAlpha = alpha;
                    for (let y = 0; y < h; y += 2) {
                        const ov = amp * 2.2;
                        g.drawImage(src, 0, y, w, 2, Math.sin(y * 0.045 + phase) * amp - ov / 2, y, w + ov, 2);
                    }
                };
                pass(A, 1);
                pass(B, s);
                const cx = w / 2;
                const cy = h / 2;
                const R = Math.hypot(cx, cy);
                for (let i = 0; i < 3; i++) {
                    const kk = k * 1.15 - i * 0.12;
                    if (kk <= 0 || kk >= 1) continue;
                    g.globalAlpha = (1 - kk) * 0.85;
                    g.lineWidth = 2 + (1 - kk) * 8;
                    g.strokeStyle = i === 1 ? '#ffffff' : st.acc;
                    g.beginPath();
                    g.arc(cx, cy, kk * R, 0, Math.PI * 2);
                    g.stroke();
                }
                g.globalAlpha = 1;
            },
        },
    };

    /** Farve (#rgb, #rrggbb eller rgb(r g b)) til [r, g, b], ellers null. */
    const parseRgb = v => {
        const t = String(v || '').trim();
        let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
        if (m) {
            const h = m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1];
            return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16));
        }
        m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(t);
        return m ? m.slice(1, 4).map(x => Math.min(255, +x)) : null;
    };
    const toHex = a => '#' + a.map(x => Math.max(0, Math.min(255, Math.round(+x) || 0)).toString(16).padStart(2, '0')).join('');
    const CL_POS = ['hidden', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
    const CL_STYLES = ['pill', 'tab', 'line', 'bar', 'text', 'outline', 'corners', 'glass', 'dot'];
    const CL_COLORS = ['auto', 'white', 'accent', 'custom'];
    // CAM-mærkets placering: ét valg pr. sted (stort kamera, små fliser, fuldskærm). Stilarterne genereres, så de følger valgene.
    const CL_PLACES = [
        ['b', 'big', ['.tile.single:not(.fs)', '.tile.main:not(.fs)']],
        ['s', 'small', ['.tile.mini:not(.fs)', '.tile.grid:not(.fs)']],
        ['f', 'fs', ['.tile.fs']],
    ];
    /** Mærkets placering (standard øverst til venstre). */
    const clPos = (c, key) => CL_POS.includes(c[key]) ? c[key] : 'top-left';
    const CL_CSS = CL_PLACES.map(([k, , sels]) => CL_POS.slice(1).map(q =>
        sels.map(sl => `ha-card[data-cl${k}="${q}"] ${sl} .camlabel.at-${q}`).join(',\n') + ' { display: inline-block; }').join('\n')).join('\n');
    const READOUT_ITEMS = ['connection', 'resolution', 'fps', 'bitrate', 'clock'];
    const READOUT_DEFAULT = ['connection', 'resolution', 'clock'];
    const INTRO_VARIANTS = ['boot', 'frame', 'focus', 'scan', 'iris', 'tv', 'blinds', 'none'];
    const INTRO_MIN = {boot: 1500, frame: 1100, focus: 500, scan: 600, iris: 600, tv: 600, blinds: 600};   // ms før billedet må vises (ved normal hastighed)

    // Persienne-opstarten animerer en længde. @property virker ikke i shadow DOM, så den registreres her.
    try {
        if (window.CSS && CSS.registerProperty) {
            CSS.registerProperty({name: '--pn-s', syntax: '<length>', inherits: false, initialValue: '0px'});
        }
    } catch (e) {
        // allerede registreret eller ikke understøttet (så springer persiennerne bare)
    }

    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
    const clone = obj => JSON.parse(JSON.stringify(obj));

    /* ======================================================================
     * 1. PLAYER
     * Et element, der henter en stream fra go2rtc via HA og viser den i en <video>.
     * Tilpasset fra VideoRTC (AlexxIT/WebRTC, MIT).
     * ==================================================================== */
    class PanoptesPlayer extends HTMLElement {
        constructor() {
            super();

            this.DISCONNECT_TIMEOUT = 5000;  // ms før en stream lukkes, når den ikke er i syne
            this.RECONNECT_TIMEOUT = 15000;  // ms mellem genforbindelsesforsøg

            this.CODECS = [
                'avc1.640029',      // H.264 high 4.1
                'avc1.64002A',      // H.264 high 4.2
                'avc1.640033',      // H.264 high 5.1
                'hvc1.1.6.L153.B0', // H.265 main 5.1
                'mp4a.40.2',        // AAC LC
                'mp4a.40.5',        // AAC HE
                'flac',
                'opus',
            ];

            this.mode = DEFAULT_MODE;
            this.media = DEFAULT_MEDIA;
            this.background = false;         // true = streamen kører også, når den ikke er i syne
            this.visibilityThreshold = 0;    // 0 = ingen pause uden for syne
            this.visibilityTarget = null;    // element der observeres for synlighed (standard: playeren selv)

            this.pcConfig = {
                bundlePolicy: 'max-bundle',
                iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
                sdpSemantics: 'unified-plan',
            };

            // Hvilken stream der vises
            this.url = '';
            this.entity = '';
            this.server = '';
            this.poster = '';

            this.video = null;
            this.ws = null;
            this.pc = null;
            this.bytes = 0;
            this.wsURL = '';
            this.wsState = WebSocket.CLOSED;
            this.pcState = WebSocket.CLOSED;
            this.connectTS = 0;
            this.mseCodecs = '';

            this._hass = null;
            this._active = false;      // true = streamen skal køre (kortet er synligt)
            this._signing = false;     // venter på signeret adresse fra HA
            this._wasOpen = false;
            this._gen = 0;             // tæller, så gamle svar kan ignoreres
            this._stopTID = 0;
            this._reconnectTID = 0;
            this._io = null;
            this._hold = false;        // true = holdt stoppet udefra (skjult kamera i fuldskærm), uanset synlighed
            this._built = false;
            this._ondata = null;
            this._handlers = {};
            this._posterRemote = false;

            this._onVisibility = () => {
                if (document.hidden) this._scheduleStop();
                else if (this.isConnected) this._resume();
            };
        }

        set hass(hass) {
            const first = !this._hass;
            this._hass = hass;
            // Forbind først, når hass er klar. Må ikke forbinde ved hver opdatering (ville omgå ventetiden).
            if (first && this._active) this._connect();
        }

        get hass() {
            return this._hass;
        }

        /** Opretter video-elementet. Kaldes af kortet, før player'en sættes ind i siden. */
        init() {
            if (this._built) return;
            this._built = true;

            const video = this.video = document.createElement('video');
            video.playsInline = true;
            video.preload = 'auto';
            video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#000';
            this.appendChild(video);

            video.addEventListener('error', ev => {
                // Ignorer fejlen, der opstår, når vi selv rydder video-kilden
                if (!video.getAttribute('src') && !video.srcObject) return;
                console.warn(ev);
                if (this.ws) this.ws.close(); // giver genforbindelse ved ødelagt MSE-stream
            });

            // Safari lyver om understøttede lydcodecs
            const m = window.navigator.userAgent.match(/Version\/(\d+).+Safari/);
            if (m) {
                const skip = m[1] < '13' ? 'mp4a.40.2' : m[1] < '14' ? 'flac' : 'opus';
                this.CODECS.splice(this.CODECS.indexOf(skip));
            }

            if (this.poster) this.setPoster(this.poster);
        }

        setStream({url, entity, mode, media}) {
            this.url = url || '';
            this.entity = entity || '';
            this.mode = mode || DEFAULT_MODE;
            this.media = media || DEFAULT_MEDIA;
        }

        setPoster(poster) {
            this.poster = poster || '';
            this._posterRemote = !!this.poster && (this.poster.indexOf('://') > 0 || this.poster.charAt(0) === '/');
            if (this._posterRemote && this.video) this.video.poster = this.poster;
        }

        /** Skift til en anden stream (efter setStream). */
        reload() {
            this._disconnect();
            this._connect();
        }

        /** Stop alt med det samme (bruges, når kortet bygges om). */
        destroy() {
            this._active = false;
            if (this._stopTID) {
                clearTimeout(this._stopTID);
                this._stopTID = 0;
            }
            this._removeObservers();
            this._disconnect();
        }

        play() {
            if (!this.video) return;
            this.video.play().catch(() => {
                if (!this.video.muted) {
                    this.video.muted = true;
                    this.video.play().catch(er => console.warn(er));
                }
            });
        }

        send(value) {
            if (this.ws) this.ws.send(JSON.stringify(value));
        }

        get hasAudio() {
            const v = this.video;
            if (!v) return false;
            return !!(
                (v.srcObject && v.srcObject.getAudioTracks && v.srcObject.getAudioTracks().length) ||
                (v.mozHasAudio || v.webkitAudioDecodedByteCount) ||
                (v.audioTracks && v.audioTracks.length)
            );
        }

        _status(mode, text) {
            this.dispatchEvent(new CustomEvent('status', {detail: {mode, text: text || ''}}));
        }

        _codecs(isSupported) {
            return this.CODECS
                .filter(codec => this.media.indexOf(codec.indexOf('vc1') > 0 ? 'video' : 'audio') >= 0)
                .filter(codec => isSupported(`video/mp4; codecs="${codec}"`)).join();
        }

        /* ---------- Livscyklus: start/stop efter hvad der er i syne ---------- */

        connectedCallback() {
            if (!this._built) return;
            this._addObservers();
            this._resume();
        }

        disconnectedCallback() {
            this._removeObservers();
            this._scheduleStop();
        }

        _addObservers() {
            if (this.background) return;

            if ('hidden' in document) {
                document.addEventListener('visibilitychange', this._onVisibility);
            }

            if ('IntersectionObserver' in window && this.visibilityThreshold) {
                this._io = new IntersectionObserver(entries => {
                    entries.forEach(entry => {
                        if (!entry.isIntersecting) this._scheduleStop();
                        else if (this.isConnected) this._resume();
                    });
                }, {threshold: this.visibilityThreshold});
                // Observeres et element, der ikke skaleres af digital zoom (ellers regnes en zoomet video for "uden for syne")
                this._io.observe(this.visibilityTarget || this);
            }
        }

        _removeObservers() {
            document.removeEventListener('visibilitychange', this._onVisibility);
            if (this._io) {
                this._io.disconnect();
                this._io = null;
            }
        }

        /** Holder streamen stoppet (eller slipper den igen), uanset hvad synligheden siger. */
        setHold(on) {
            on = !!on;
            if (on === this._hold) return;
            this._hold = on;
            if (on) this._scheduleStop();
            else if (this.isConnected) this._resume();
        }

        _resume() {
            if (this._hold) return;
            if (this._stopTID) {
                clearTimeout(this._stopTID);
                this._stopTID = 0;
            }
            this._active = true;

            // Video pauser af sig selv, når den fjernes fra siden
            const v = this.video;
            if (v && (v.srcObject || v.getAttribute('src'))) {
                const seek = v.seekable;
                if (seek.length > 0) v.currentTime = seek.end(seek.length - 1);
                this.play();
            }

            this._connect();
        }

        _scheduleStop() {
            if (this.background) return;
            this._active = false;
            if (this._stopTID) return;

            this._stopTID = setTimeout(() => {
                this._stopTID = 0;
                this._disconnect();
            }, this.DISCONNECT_TIMEOUT);
        }

        /* ---------- Forbindelse ---------- */

        /** Henter signeret adresse fra HA og åbner WebSocket. */
        _connect() {
            if (!this._active || !this.isConnected || !this._hass || !this._built) return false;
            if (this.ws || this.pc || this._signing) return false;
            if (!this.url && !this.entity) return false;

            this._signing = true;
            DBG.n.connect++;
            this._status('loading');
            const gen = this._gen;

            this._hass.callWS({type: 'auth/sign_path', path: '/api/webrtc/ws'}).then(data => {
                this._signing = false;
                if (gen !== this._gen || !this._active) return;

                const signed = this._hass.hassUrl(data.path);

                if (this.poster && !this._posterRemote) {
                    this.video.poster = signed + '&poster=' + encodeURIComponent(this.poster);
                }

                let wsURL = 'ws' + signed.substring(4);
                if (this.entity) wsURL += '&entity=' + encodeURIComponent(this.entity);
                else wsURL += '&url=' + encodeURIComponent(this.url);
                if (this.server) wsURL += '&server=' + encodeURIComponent(this.server);
                this.wsURL = wsURL;

                if (!this._startSocket()) this._status('error', tr('tile.cant_connect'));
            }).catch(er => {
                this._signing = false;
                this._status('error', (er && er.message) || String(er));
            });

            return true;
        }

        _startSocket() {
            if (!this.isConnected || !this.wsURL || this.ws || this.pc) return false;

            this.wsState = WebSocket.CONNECTING;
            this._wasOpen = false;
            this.connectTS = Date.now();

            const ws = new WebSocket(this.wsURL);
            this.ws = ws;
            ws.binaryType = 'arraybuffer';
            ws.addEventListener('open', () => {
                if (this.ws === ws) this._onOpen(ws);
            });
            ws.addEventListener('close', () => {
                if (this.ws === ws) this._onClose();
            });
            return true;
        }

        _disconnect() {
            DBG.n.stop++;
            this._gen++;
            this._signing = false;

            if (this._reconnectTID) {
                clearTimeout(this._reconnectTID);
                this._reconnectTID = 0;
            }

            this.wsState = WebSocket.CLOSED;
            if (this.ws) {
                const ws = this.ws;
                this.ws = null;
                ws.close();
            }

            this.pcState = WebSocket.CLOSED;
            if (this.pc) {
                this.pc.getSenders().forEach(sender => {
                    if (sender.track) sender.track.stop();
                });
                this.pc.close();
                this.pc = null;
            }

            if (this.video) {
                this.video.src = '';
                this.video.srcObject = null;
            }
        }

        _onOpen(ws) {
            this.wsState = WebSocket.OPEN;
            this._wasOpen = true;

            ws.addEventListener('message', ev => {
                if (this.ws !== ws) return;
                if (typeof ev.data === 'string') {
                    const msg = JSON.parse(ev.data);
                    for (const name in this._handlers) this._handlers[name](msg);
                } else if (this._ondata) {
                    this.bytes += ev.data.byteLength || 0;
                    this._ondata(ev.data);
                }
            });

            this._ondata = null;
            this._handlers = {};

            // Status fra serveren
            this._handlers['stream'] = msg => {
                switch (msg.type) {
                    case 'error':
                        this._status('error', msg.value);
                        break;
                    case 'mse':
                    case 'hls':
                    case 'mp4':
                    case 'mjpeg':
                        this._status(msg.type.toUpperCase());
                        break;
                }
            };

            const modes = [];

            if (this.mode.indexOf('mse') >= 0 && ('MediaSource' in window || 'ManagedMediaSource' in window)) {
                modes.push('mse');
                this._onMse();
            } else if (this.mode.indexOf('hls') >= 0 && this.video.canPlayType('application/vnd.apple.mpegurl')) {
                modes.push('hls');
                this._onHls();
            }

            if (this.mode.indexOf('webrtc') >= 0 && 'RTCPeerConnection' in window) {
                modes.push('webrtc');
                this._onWebrtc();
            }

            if (this.mode.indexOf('mjpeg') >= 0) {
                if (modes.length) {
                    this._handlers['mjpeg'] = msg => {
                        if (msg.type !== 'error' || msg.value.indexOf(modes[0]) !== 0) return;
                        this._onMjpeg();
                    };
                } else {
                    modes.push('mjpeg');
                    this._onMjpeg();
                }
            }

            return modes;
        }

        _onClose() {
            if (this.wsState === WebSocket.CLOSED) return false;

            if (!this._wasOpen) {
                this._status('error', tr('tile.conn_failed'));
            }

            this.wsState = WebSocket.CONNECTING;
            this.ws = null;

            // Genforbind højst hvert RECONNECT_TIMEOUT ms
            const delay = Math.max(this.RECONNECT_TIMEOUT - (Date.now() - this.connectTS), 0);
            this._reconnectTID = setTimeout(() => {
                this._reconnectTID = 0;
                DBG.n.reconn++;
                this._connect();
            }, delay);

            return true;
        }

        /* ---------- Afspilningsmetoder ---------- */

        _onMse() {
            /** @type {MediaSource} */
            let ms;

            if ('ManagedMediaSource' in window) {
                const MediaSource = window.ManagedMediaSource;

                ms = new MediaSource();
                ms.addEventListener('sourceopen', () => {
                    this.send({type: 'mse', value: this._codecs(MediaSource.isTypeSupported)});
                }, {once: true});

                this.video.disableRemotePlayback = true;
                this.video.srcObject = ms;
            } else {
                ms = new MediaSource();
                ms.addEventListener('sourceopen', () => {
                    URL.revokeObjectURL(this.video.src);
                    this.send({type: 'mse', value: this._codecs(MediaSource.isTypeSupported)});
                }, {once: true});

                this.video.src = URL.createObjectURL(ms);
                this.video.srcObject = null;
            }

            this.play();

            this.mseCodecs = '';

            this._handlers['mse'] = msg => {
                if (msg.type !== 'mse') return;

                this.mseCodecs = msg.value;

                const sb = ms.addSourceBuffer(msg.value);
                sb.mode = 'segments';
                sb.addEventListener('updateend', () => {
                    if (!sb.updating && bufLen > 0) {
                        try {
                            const data = buf.slice(0, bufLen);
                            sb.appendBuffer(data);
                            bufLen = 0;
                        } catch (e) {
                            // ignoreres
                        }
                    }

                    if (!sb.updating && sb.buffered && sb.buffered.length) {
                        const end = sb.buffered.end(sb.buffered.length - 1);
                        const start = end - 5;
                        const start0 = sb.buffered.start(0);
                        if (start > start0) {
                            sb.remove(start0, start);
                            ms.setLiveSeekableRange(start, end);
                        }
                        if (this.video.currentTime < start) {
                            this.video.currentTime = start;
                        }
                        const gap = end - this.video.currentTime;
                        this.video.playbackRate = gap > 0.1 ? gap : 0.1;
                    }
                });

                const buf = new Uint8Array(2 * 1024 * 1024);
                let bufLen = 0;

                this._ondata = data => {
                    if (sb.updating || bufLen > 0) {
                        const b = new Uint8Array(data);
                        buf.set(b, bufLen);
                        bufLen += b.byteLength;
                    } else {
                        try {
                            sb.appendBuffer(data);
                        } catch (e) {
                            // ignoreres
                        }
                    }
                };
            };
        }

        _onWebrtc() {
            const pc = new RTCPeerConnection(this.pcConfig);

            pc.addEventListener('icecandidate', ev => {
                if (ev.candidate && this.mode.indexOf('webrtc/tcp') >= 0 && ev.candidate.protocol === 'udp') return;

                const candidate = ev.candidate ? ev.candidate.toJSON().candidate : '';
                this.send({type: 'webrtc/candidate', value: candidate});
            });

            pc.addEventListener('connectionstatechange', () => {
                if (pc.connectionState === 'connected') {
                    const tracks = pc.getTransceivers()
                        .filter(tr => tr.currentDirection === 'recvonly') // spring inaktive over
                        .map(tr => tr.receiver.track);
                    const video2 = document.createElement('video');
                    video2.addEventListener('loadeddata', () => this._onPcVideo(video2), {once: true});
                    video2.srcObject = new MediaStream(tracks);
                } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                    pc.close(); // stopper flere events

                    if (this.pc === pc) {
                        this.pcState = WebSocket.CLOSED;
                        this.pc = null;
                        this._connect();
                    }
                }
            });

            this._handlers['webrtc'] = msg => {
                switch (msg.type) {
                    case 'webrtc/candidate':
                        if (this.mode.indexOf('webrtc/tcp') >= 0 && msg.value.indexOf(' udp ') > 0) return;

                        pc.addIceCandidate({candidate: msg.value, sdpMid: '0'}).catch(er => console.warn(er));
                        break;
                    case 'webrtc/answer':
                        pc.setRemoteDescription({type: 'answer', sdp: msg.value}).catch(er => console.warn(er));
                        break;
                    case 'error':
                        if (msg.value.indexOf('webrtc/offer') < 0) return;
                        pc.close();
                }
            };

            this._createOffer(pc).then(offer => {
                this.send({type: 'webrtc/offer', value: offer.sdp});
            });

            this.pcState = WebSocket.CONNECTING;
            this.pc = pc;
        }

        async _createOffer(pc) {
            try {
                if (this.media.indexOf('microphone') >= 0) {
                    const media = await navigator.mediaDevices.getUserMedia({audio: true});
                    media.getTracks().forEach(track => {
                        pc.addTransceiver(track, {direction: 'sendonly'});
                    });
                }
            } catch (e) {
                console.warn(e);
            }

            for (const kind of ['video', 'audio']) {
                if (this.media.indexOf(kind) >= 0) {
                    pc.addTransceiver(kind, {direction: 'recvonly'});
                }
            }

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            return offer;
        }

        _onPcVideo(video2) {
            if (this.pc) {
                // Video+lyd > video, H265 > H264, WebRTC > MSE
                let rtcPriority = 0, msePriority = 0;

                const stream = video2.srcObject;
                if (stream.getVideoTracks().length > 0) rtcPriority += 0x220;
                if (stream.getAudioTracks().length > 0) rtcPriority += 0x102;

                if (this.mseCodecs.indexOf('hvc1.') >= 0) msePriority += 0x230;
                if (this.mseCodecs.indexOf('avc1.') >= 0) msePriority += 0x210;
                if (this.mseCodecs.indexOf('mp4a.') >= 0) msePriority += 0x101;

                if (rtcPriority >= msePriority) {
                    this.video.srcObject = stream;
                    this.play();

                    this.pcState = WebSocket.OPEN;

                    this.wsState = WebSocket.CLOSED;
                    if (this.ws) {
                        const ws = this.ws;
                        this.ws = null;
                        ws.close();
                    }

                    this._status('RTC');
                } else {
                    this.pcState = WebSocket.CLOSED;
                    if (this.pc) {
                        this.pc.close();
                        this.pc = null;
                    }
                }
            }

            video2.srcObject = null;
        }

        _onMjpeg() {
            this._ondata = data => {
                this.video.poster = 'data:image/jpeg;base64,' + PanoptesPlayer.btoa(data);
            };

            this.send({type: 'mjpeg'});
        }

        _onHls() {
            this._handlers['hls'] = msg => {
                if (msg.type !== 'hls') return;

                const url = 'http' + this.wsURL.substring(2, this.wsURL.indexOf('/ws')) + '/hls/';
                const playlist = msg.value.replace('hls/', url);
                this.video.src = 'data:application/vnd.apple.mpegurl;base64,' + btoa(playlist);
                this.play();
            };

            this.send({type: 'hls', value: this._codecs(type => this.video.canPlayType(type))});
        }

        static btoa(buffer) {
            const bytes = new Uint8Array(buffer);
            const len = bytes.byteLength;
            let binary = '';
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return window.btoa(binary);
        }
    }

    /* ======================================================================
     * 2. KORTET
     * Kortet viser ét eller flere kameraer. Hvert kamera er en "flise"
     * (PanoptesTile) med egen player, titel, knapper, PTZ og zoom.
     * Kortet (PanoptesCard) vælger layout og hvilken rolle hver flise har.
     * ==================================================================== */

    const CARD_CSS = `
        .dbg {position: absolute; left: 6px; bottom: 6px; z-index: 50; max-width: calc(100% - 12px); padding: 4px 8px; border-radius: 6px; background: rgba(0,0,0,.72); color: #9f9; font: 11px/1.35 monospace; white-space: pre-wrap; pointer-events: none;}
        :host { display: block; }
        [hidden] { display: none !important; }
        ha-card {
            position: relative;
            overflow: hidden;
            background: #000;
            height: 100%;
        }
        ha-card.multi {
            overflow: visible;
            background: transparent;
            box-shadow: none;
            border: none;
        }

        /* Layout: fliserne ligger i et gitter, og rollerne bestemmer placeringen */
        .wall { display: grid; gap: var(--pn-gap, 8px); }
        .wall[data-layout="single"] { grid-template-columns: minmax(0, 1fr); }
        .wall[data-layout="grid"],
        .wall[data-layout="focus"][data-strip="bottom"] { grid-template-columns: repeat(var(--pn-cols, 2), minmax(0, 1fr)); }
        .wall[data-layout="focus"][data-strip="right"] { grid-template-columns: minmax(0, 1fr) minmax(0, 26%); }

        .tile {
            position: relative;
            min-width: 0;
            min-height: 0;
            background: #000;
            overflow: hidden;
        }
        .multi .tile { border-radius: var(--pn-radius, var(--ha-card-border-radius, 12px)); }
        ha-card.has-radius { border-radius: var(--pn-radius); }
        .tile.fs { border-radius: 0; width: 100%; height: 100%; }

        .player {
            position: relative;
            width: 100%;
            aspect-ratio: var(--pn-ar, 16/9);
            background: #000;
            overflow: hidden;
            touch-action: pan-y;
            user-select: none;
            -webkit-user-select: none;
            container-type: inline-size;
        }
        .tile.fs .player { aspect-ratio: auto; height: 100%; }
        .wall[data-strip="right"] .tile.mini:not(.fs) .player { aspect-ratio: auto; height: 100%; }

        .tile.mini:not(.fs), .tile.grid { cursor: pointer; }
        .tile.mini:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: -2px; }
        /* Hover på miniaturer og gitterfliser: et næsten usynligt lysere lag, ikke et filter over videoen (filter over video kan få naboflisers billede til at forsvinde i nogle browsere) */
        .tile.mini:not(.fs) .player::after, .tile.grid:not(.fs) .player::after { content: ""; position: absolute; inset: 0; background: #fff; opacity: 0; transition: opacity 0.15s; pointer-events: none; z-index: 1; }
        .tile.mini:not(.fs):hover .player::after, .tile.grid:not(.fs):hover .player::after { opacity: 0.08; }
        .tile.mini:not(.fs) panoptes-player video { object-fit: cover !important; }

        .zoom {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            transform-origin: 50% 50%;
            transition: opacity 0.8s ease, filter 1.1s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .zoom panoptes-player { display: block; width: 100%; height: 100%; }

        .header {
            position: absolute;
            top: 0; left: 0; right: 0;
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            align-items: center;
            padding: var(--pn-title-offset, 14px) 12px 0;
            box-sizing: border-box;
            color: #fff;
            pointer-events: none;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
            font-size: 14px;
            z-index: 2;
        }
        .h-left { justify-self: start; display: flex; align-items: center; gap: 8px; }
        .h-center { justify-self: center; display: flex; align-items: center; gap: 8px; }
        .h-right { justify-self: end; display: flex; align-items: center; gap: 8px; }
        /* CAM-mærke: nummeret i accentfarven */
        .camlabel {
            display: none;
            flex: none;
            font: 600 0.78em/1 ui-monospace, "Cascadia Mono", Consolas, "SF Mono", monospace;
            letter-spacing: 0.08em;
            padding: 3px 7px;
            border-radius: 6px;
            background: rgba(0, 0, 0, 0.4);
            color: rgba(255, 255, 255, 0.75);
            white-space: nowrap;
            text-shadow: none;
            pointer-events: none;
            position: relative;
            top: calc(var(--pn-cl-off, 14px) - var(--pn-title-offset, 14px));
        }
        .h-left .camlabel { left: calc(var(--pn-cl-side, 12px) - 12px); }
        .h-right .camlabel { left: calc(12px - var(--pn-cl-side, 12px)); }
        .camlabel .cl-n { font-weight: 700; color: var(--pn-intro, #4fd8ff); }
        .camlabel.cl-name { font: 500 14px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.01em; color: #fff; }
        .camlabel.cl-name .cl-n { font-weight: 500; color: inherit; }
        .tile.mini:not(.fs) .camlabel.cl-name { font-size: 12px; }
        .cl-b .camlabel, .cl-bc .camlabel { top: 0; }
        .cl-bc {
            position: absolute;
            left: 0; right: 0;
            bottom: var(--pn-cl-off, 14px);
            display: flex;
            justify-content: center;
            pointer-events: none;
            z-index: 2;
        }
        /* Mærkets stilarter */
        ha-card[data-cst="tab"] .camlabel {
            padding: 4px 16px 4px 9px; border-radius: 0;
            background: var(--pn-intro, #4fd8ff); color: #04141a;
            clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
        }
        ha-card[data-cst="tab"] .camlabel .cl-n, ha-card[data-cst="tab"] .camlabel.cl-name { color: #04141a; }
        ha-card[data-cst="line"] .camlabel {
            padding: 2px 16px 5px 0; border-radius: 0; color: #fff;
            background: linear-gradient(90deg, var(--pn-intro, #4fd8ff), transparent) left bottom / 100% 1.5px no-repeat;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        ha-card[data-cst="bar"] .camlabel {
            padding: 1px 0 1px 7px; border-radius: 0; background: none; color: #fff;
            border-left: 2px solid var(--pn-intro, #4fd8ff);
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        ha-card[data-cst="text"] .camlabel {
            padding: 0; border-radius: 0; background: none; color: #fff;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        ha-card[data-cst="outline"] .camlabel {
            padding: 3px 8px; background: none; border: 1px solid var(--pn-intro, #4fd8ff); border-radius: 6px; color: #fff;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
        }
        ha-card[data-cst="corners"] .camlabel {
            --c: var(--pn-intro, #4fd8ff);
            padding: 5px 11px; border-radius: 0; color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
            background:
                linear-gradient(var(--c), var(--c)) 0 0 / 7px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 0 0 / 1.5px 7px no-repeat,
                linear-gradient(var(--c), var(--c)) 100% 0 / 7px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 100% 0 / 1.5px 7px no-repeat,
                linear-gradient(var(--c), var(--c)) 0 100% / 7px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 0 100% / 1.5px 7px no-repeat,
                linear-gradient(var(--c), var(--c)) 100% 100% / 7px 1.5px no-repeat, linear-gradient(var(--c), var(--c)) 100% 100% / 1.5px 7px no-repeat;
        }
        ha-card[data-cst="glass"] .camlabel {
            padding: 4px 10px; border-radius: 8px; color: #fff;
            background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.2);
            -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
        }
        ha-card[data-cst="dot"] .camlabel { padding: 0; border-radius: 0; background: none; color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8); }
        ha-card[data-cst="dot"] .camlabel::before {
            content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; vertical-align: 0.08em;
            background: var(--pn-intro, #4fd8ff); box-shadow: 0 0 6px var(--pn-intro, #4fd8ff);
        }
        /* Tekstfarve (hvid, accent eller egen) overstyrer stilens egen */
        ha-card[data-clc] .camlabel, ha-card[data-clc] .camlabel .cl-n, ha-card[data-clc] .camlabel .cl-t { color: var(--pn-clt) !important; }
        ha-card[data-cst="tab"][data-clc="accent"] .camlabel, ha-card[data-cst="tab"][data-clc="custom"] .camlabel { background: rgba(0, 0, 0, 0.55); }
        /* Udlæsningen i mærkets stil */
        ha-card.ro-st[data-cst="pill"] .readout span:not(:empty) { background: rgba(0, 0, 0, 0.4); border-radius: 6px; padding: 3px 7px; }
        ha-card.ro-st[data-cst="line"] .readout span:not(:empty) { padding: 2px 12px 4px 0; background: linear-gradient(90deg, var(--pn-intro, #4fd8ff), transparent) left bottom / 100% 1px no-repeat; }
        ha-card.ro-st[data-rol="label"][data-clc] .readout span:not(:empty) { color: var(--pn-clt) !important; }
        ha-card.ro-st[data-rol="label"][data-cst="tab"][data-clc="accent"] .readout span:not(:empty), ha-card.ro-st[data-rol="label"][data-cst="tab"][data-clc="custom"] .readout span:not(:empty) { background: rgba(0, 0, 0, 0.55); }
        ha-card.ro-st[data-cst="outline"] .readout span:not(:empty) { padding: 2px 7px; border: 1px solid var(--pn-intro, #4fd8ff); border-radius: 6px; }
        ha-card.ro-st[data-cst="glass"] .readout span:not(:empty) { padding: 3px 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.2); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
        ha-card.ro-st[data-cst="tab"] .readout span:not(:empty) { padding: 3px 12px 3px 7px; background: var(--pn-intro, #4fd8ff); color: #04141a; text-shadow: none; clip-path: polygon(0 0, 100% 0, calc(100% - 6px) 100%, 0 100%); }
        ha-card.ro-st[data-cst="corners"] .readout span:not(:empty) {
            --c: var(--pn-intro, #4fd8ff); padding: 4px 9px;
            background:
                linear-gradient(var(--c), var(--c)) 0 0 / 5px 1px no-repeat, linear-gradient(var(--c), var(--c)) 0 0 / 1px 5px no-repeat,
                linear-gradient(var(--c), var(--c)) 100% 0 / 5px 1px no-repeat, linear-gradient(var(--c), var(--c)) 100% 0 / 1px 5px no-repeat,
                linear-gradient(var(--c), var(--c)) 0 100% / 5px 1px no-repeat, linear-gradient(var(--c), var(--c)) 0 100% / 1px 5px no-repeat,
                linear-gradient(var(--c), var(--c)) 100% 100% / 5px 1px no-repeat, linear-gradient(var(--c), var(--c)) 100% 100% / 1px 5px no-repeat;
        }
        ha-card.ro-st[data-cst="dot"] .readout span:not(:empty)::before { content: ""; display: inline-block; width: 5px; height: 5px; margin-right: 6px; border-radius: 50%; vertical-align: 0.05em; background: var(--pn-intro, #4fd8ff); }
        ha-card.ro-st[data-cst="bar"] .readout span:not(:empty) { padding: 1px 0 1px 7px; border-left: 2px solid var(--pn-intro, #4fd8ff); }
        .cl-b {
            position: absolute;
            left: var(--pn-cl-side, 10px); right: var(--pn-cl-side, 10px);
            bottom: var(--pn-clb, 10px);
            display: flex;
            justify-content: space-between;
            pointer-events: none;
            z-index: 2;
        }
        .tile.mini:not(.fs) .cl-b, .tile.grid:not(.fs) .cl-b { left: 8px; right: 8px; bottom: 8px; }
        .camlabel.at-bottom-right { margin-left: auto; }
        ${CL_CSS}
        .title { display: inline-flex; align-items: baseline; gap: 8px; }
        .title .name { font-weight: 500; }
        .title .status { opacity: 0.7; font-size: 12px; }
        .title.no-name .name { display: none; }
        .bottom-title {
            position: absolute;
            left: 0; right: 0;
            bottom: var(--pn-title-offset, 14px);
            display: flex;
            justify-content: center;
            color: #fff;
            pointer-events: none;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.7);
            font-size: 14px;
            z-index: 2;
        }
        .quality {
            pointer-events: auto;
            cursor: pointer;
            color: #fff;
            background: rgba(0, 0, 0, 0.4);
            border: 0;
            border-radius: 12px;
            padding: 2px 10px;
            font: inherit;
            font-size: 13px;
            opacity: 0.8;
        }
        .quality:hover { opacity: 1; }
        .car-pause {
            pointer-events: auto;
            cursor: pointer;
            display: grid;
            place-items: center;
            width: 28px; height: 24px;
            padding: 0;
            border: 0;
            border-radius: 12px;
            background: rgba(0, 0, 0, 0.4);
            color: #fff;
            opacity: 0.8;
        }
        .car-pause:hover, .car-pause.on { opacity: 1; }
        .car-pause.on { background: var(--pn-intro, #4fd8ff); color: #04141a; }
        .car-pause ha-icon { --mdc-icon-size: 18px; }
        /* Med en kvalitetsknap (HD/SD) hænger pauseknappen lige under den */
        .h-right.q2 { position: relative; }
        .h-right.q2 .car-pause { position: absolute; top: 100%; right: 0; margin-top: 6px; }
        .tile.mini:not(.fs) .car-pause, .tile.grid:not(.fs) .car-pause { display: none; }

        .msg {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 10px;
            color: #fff;
            font-size: 14px;
            text-align: center;
            padding: 16px;
            pointer-events: none;
            z-index: 1;
        }
        .spinner {
            width: 36px;
            height: 36px;
            border: 3px solid rgba(255, 255, 255, 0.25);
            border-top-color: #fff;
            border-radius: 50%;
            animation: pn-spin 1s linear infinite;
        }
        @keyframes pn-spin { to { transform: rotate(360deg); } }

        .controls {
            position: absolute;
            left: 8px; right: 8px; bottom: 6px;
            display: flex;
            align-items: center;
            gap: 4px;
            z-index: 2;
        }
        .controls ha-icon, .ring ha-icon {
            color: #fff;
            cursor: pointer;
            filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
        }
        .controls .space { flex: 1; }

        .ptz {
            position: absolute;
            top: 50%;
            right: 10px;
            transform: translateY(-50%);
            opacity: var(--pn-ptz-opacity, 0.4);
            transition: opacity 0.3s ease-in-out;
            z-index: 2;
        }
        .ptz:hover { opacity: 1; }
        .ring {
            position: relative;
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.3);
        }
        .ring ha-icon { position: absolute; }
        .ring .up { top: 5px; left: 50%; transform: translateX(-50%); }
        .ring .down { bottom: 5px; left: 50%; transform: translateX(-50%); }
        .ring .left { left: 5px; top: 50%; transform: translateY(-50%); }
        .ring .right { right: 5px; top: 50%; transform: translateY(-50%); }
        .ring .off { opacity: 0.2; pointer-events: none; }

        /* Miniaturer og gitterfliser: kun billede og titel (knapper og PTZ kommer i fuldskærm) */
        .tile.mini:not(.fs) { --pn-title-offset: 8px; --pn-cl-off: 8px; --pn-cl-side: 12px; }
        .tile.mini:not(.fs) .header { font-size: 12px; padding-left: 8px; padding-right: 8px; }
        .tile.mini:not(.fs) .bottom-title { font-size: 12px; }
        .tile.mini:not(.fs) .spinner { width: 22px; height: 22px; border-width: 2px; }
        .tile.mini:not(.fs) .msg { font-size: 11px; padding: 6px; }
        .tile.mini:not(.fs) .quality, .tile.mini:not(.fs) .controls, .tile.mini:not(.fs) .ptz,
        .tile.grid .controls, .tile.grid .ptz { display: none; }
        .tile.fs .controls { display: flex; }
        .tile.fs .ptz { display: block; }

        /* Kontrolpanel (privatliv, presets, patrulje, lys) */
        .cp-btn {
            pointer-events: auto;
            cursor: pointer;
            display: grid;
            place-items: center;
            width: 28px; height: 24px;
            padding: 0;
            border: 0;
            border-radius: 12px;
            background: rgba(0, 0, 0, 0.4);
            color: #fff;
            opacity: 0.8;
        }
        .cp-btn:hover, .cp-btn.on { opacity: 1; }
        .cp-btn.on { background: var(--pn-intro, #4fd8ff); color: #04141a; }
        .cp-btn ha-icon { --mdc-icon-size: 18px; }
        .cp {
            position: absolute;
            top: 44px; right: 10px;
            width: 230px;
            max-width: calc(100% - 20px);
            max-height: calc(100% - 56px);
            overflow-y: auto;
            overscroll-behavior: contain;
            box-sizing: border-box;
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            border-radius: 14px;
            background: rgba(16, 18, 22, 0.82);
            -webkit-backdrop-filter: blur(10px);
            backdrop-filter: blur(10px);
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
            color: #fff;
            font-size: 13px;
            z-index: 5;
            opacity: 0;
            visibility: hidden;
            transform: translateY(-6px);
            transition: opacity 0.2s, transform 0.2s, visibility 0.2s;
        }
        .cp.open { opacity: 1; visibility: visible; transform: none; }
        @container (max-width: 420px) {
            .cp { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-width: none; transform: translateY(8px); }
        }
        .cp.private .sec-x { display: none; }
        .cp-row { display: flex; align-items: center; gap: 8px; }
        .cp-row ha-icon { --mdc-icon-size: 20px; opacity: 0.85; }
        .cp-row .lbl { flex: 1; }
        .cp-sub { font-size: 11px; opacity: 0.65; margin-bottom: 5px; }
        .sec-x { display: flex; flex-direction: column; gap: 10px; }
        .tg {
            position: relative;
            width: 36px; height: 20px;
            padding: 0;
            border: 0;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.25);
            cursor: pointer;
            transition: background 0.2s;
        }
        .tg::after {
            content: "";
            position: absolute;
            top: 2px; left: 2px;
            width: 16px; height: 16px;
            border-radius: 50%;
            background: #fff;
            transition: transform 0.2s;
        }
        .tg.on { background: var(--pn-intro, #4fd8ff); }
        .tg.on::after { transform: translateX(16px); }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .chip {
            padding: 4px 10px;
            border: 0;
            border-radius: 99px;
            background: rgba(255, 255, 255, 0.12);
            color: #fff;
            font: inherit;
            font-size: 12px;
            cursor: pointer;
        }
        .chip.on { background: var(--pn-intro, #4fd8ff); color: #04141a; }
        .cp select {
            width: 100%;
            padding: 6px 8px;
            border: 0;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.12);
            color: #fff;
            font: inherit;
        }
        .cp option { color: #000; }
        .tile.mini:not(.fs) .cp-btn, .tile.mini:not(.fs) .cp, .tile.grid:not(.fs) .cp-btn, .tile.grid:not(.fs) .cp { display: none; }
        .tile.patrolling .ptz, .tile.private .ptz { display: none !important; }

        /* Privatlivsdækning */
        .cover {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 1;
            display: none;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: #05080c;
            color: #fff;
            overflow: hidden;
        }
        .tile.private .cover { display: flex; }
        .tile.private .msg { display: none; }
        .cover.pc-none { display: none !important; }
        .cover.pc-blur { background: rgba(0, 0, 0, 0.35); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); }
        .cv-canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; color: var(--pn-intro, #4fd8ff); }
        .cv-msg { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; text-shadow: 0 1px 6px #000; }
        .cv-msg ha-icon { --mdc-icon-size: clamp(22px, 8cqw, 48px); color: var(--pn-intro, #4fd8ff); }
        .cv-text { font-size: clamp(11px, 2.6cqw, 15px); letter-spacing: 0.04em; opacity: 0.9; }
        .cv-clock { font: 300 clamp(28px, 14cqw, 96px)/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; opacity: 0.9; }
        .tile.mini:not(.fs) .cv-text, .tile.mini:not(.fs) .cv-clock,
        .tile.grid:not(.fs) .cv-text, .tile.grid:not(.fs) .cv-clock { display: none; }
        ha-card:not(.fx-small) .tile.mini:not(.fs) .cv-canvas, ha-card:not(.fx-small) .tile.grid:not(.fs) .cv-canvas { display: none; }

        /* Teknisk udlæsning */
        .readout {
            position: absolute;
            left: 10px; right: 10px; bottom: 10px;
            display: flex;
            justify-content: space-between;
            gap: 12px;
            font: 500 clamp(9px, 1.7cqw, 12px)/1.2 ui-monospace, "Cascadia Mono", Consolas, "SF Mono", monospace;
            letter-spacing: 0.03em;
            white-space: nowrap;
            color: #fff;
            opacity: 0.85;
            transition: opacity 0.6s ease 0.15s;
            text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
            pointer-events: none;
            z-index: 2;
        }
        .tile.intro .readout { opacity: 0; transition: none; }
        .readout.has-ui { bottom: 38px; }
        .tile.mini:not(.fs) .readout, .tile.grid:not(.fs) .readout { display: none; }

        /* Frosset billede ved skift af kamera og kvalitet */
        .snap { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #000; pointer-events: none; }
        .tile.frozen .msg { display: none; }
        .quality.pulse { animation: pn-pulse 0.8s ease-out; }
        @keyframes pn-pulse {
            0% { box-shadow: 0 0 0 0 var(--pn-intro, #4fd8ff); background: var(--pn-intro, #4fd8ff); color: #04141a; }
            100% { box-shadow: 0 0 0 10px transparent; }
        }

        /* Karrusel: tynd linje, der fyldes frem mod næste skift */
        .car-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; z-index: 4; pointer-events: none; overflow: hidden; }
        .car-bar i {
            display: block;
            width: 100%; height: 100%;
            background: var(--pn-intro, #4fd8ff);
            box-shadow: 0 0 8px var(--pn-intro, #4fd8ff);
            transform-origin: left;
            transform: scaleX(var(--pn-car, 0));
            transition: transform 0.26s linear;
        }

        /* Kameraskift i layout Enkelt */
        .nav { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; z-index: 3; }
        .nav-btn {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            width: 36px; height: 36px;
            padding: 0;
            display: grid;
            place-items: center;
            border: 0;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.4);
            color: #fff;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
            pointer-events: auto;
        }
        .nav-btn.prev { left: 8px; }
        .nav-btn.next { right: 8px; }
        ha-card:hover .nav-btn, .nav-btn:focus-visible { opacity: 0.9; }
        @media (pointer: coarse) { .nav-btn { opacity: 0.5; } }
        .nav-dots { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; pointer-events: auto; }
        .nav-sides .nav-bar { display: contents; }
        .nav-bottom .nav-bar {
            position: absolute;
            bottom: 8px; left: 50%;
            transform: translateX(-50%);
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 2px 4px;
            border-radius: 99px;
            background: rgba(0, 0, 0, 0.4);
            pointer-events: auto;
        }
        .nav-bottom .nav-btn { position: static; transform: none; width: 26px; height: 26px; background: none; opacity: 0.9; }
        .nav-bottom .nav-dots { position: static; transform: none; }
        .nav-dot { width: 9px; height: 9px; padding: 0; border: 0; border-radius: 50%; background: rgba(255, 255, 255, 0.45); cursor: pointer; }
        .nav-dot.on { background: #fff; box-shadow: 0 0 4px rgba(0, 0, 0, 0.6); }


        /* Fuldskærm: hele kortet går i fuldskærm, og kun den valgte flise vises */
        ha-card.fsmode { background: #000; overflow: hidden; border-radius: 0; box-shadow: none; border: none; width: 100%; height: 100%; }
        ha-card.fsmode .wall { position: absolute; inset: 0; display: block; }
        ha-card.fsmode .tile { position: absolute; inset: 0; border-radius: 0; opacity: 0; pointer-events: none; z-index: 0; cursor: default; }
        ha-card.fsmode .tile.fs { opacity: 1; pointer-events: auto; z-index: 1; }
        ha-card.fsmode .tile.fs panoptes-player video { object-fit: contain !important; }
        ha-card.fsmode .nav { display: none; }

        /* Kameraskift i fuldskærm */
        .fsnav {
            display: none;
            position: absolute; left: 0; right: 0; bottom: 0;
            z-index: 10;
            flex-direction: column; align-items: center; gap: 8px;
            padding: 0 0 44px;
            pointer-events: none;
        }
        .fsnav.has-bar { padding-bottom: 8px; }
        ha-card.fsmode .fsnav { display: flex; }
        .fs-bar {
            display: flex; align-items: center; gap: 6px;
            padding: 2px 4px;
            border-radius: 99px;
            background: rgba(0, 0, 0, 0.4);
            pointer-events: auto;
        }
        .fs-btn {
            width: 30px; height: 30px; padding: 0;
            display: grid; place-items: center;
            border: 0; border-radius: 50%;
            background: none; color: #fff; cursor: pointer; opacity: 0.9;
        }
        .fs-btn:hover, .fs-btn:focus-visible { background: rgba(255, 255, 255, 0.18); }
        .fs-dots { display: flex; gap: 8px; }
        .fs-dot { width: 9px; height: 9px; padding: 0; border: 0; border-radius: 50%; background: rgba(255, 255, 255, 0.45); cursor: pointer; }
        .fs-dot.on { background: #fff; box-shadow: 0 0 4px rgba(0, 0, 0, 0.6); }
        .fsnav.has-thumbs .fs-dots { display: none; }
        .fs-thumbs {
            display: flex; gap: 8px;
            max-width: calc(100% - 24px);
            overflow-x: auto;
            padding: 6px;
            border-radius: 12px;
            background: rgba(0, 0, 0, 0.4);
            pointer-events: auto;
        }
        .fs-th {
            position: relative; flex: 0 0 auto;
            width: 112px; aspect-ratio: 16 / 9;
            padding: 0; border: 2px solid transparent; border-radius: 8px;
            overflow: hidden; background: #1c1c1c; color: #fff; cursor: pointer;
        }
        .fs-th img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .fs-th ha-icon { position: absolute; inset: 0; margin: auto; --mdc-icon-size: 26px; opacity: 0.5; }
        .fs-th.on { border-color: var(--pn-intro, #4fd8ff); }
        .fs-th span {
            position: absolute; left: 0; right: 0; bottom: 0;
            padding: 2px 4px; font-size: 11px; text-align: left;
            background: rgba(0, 0, 0, 0.55);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }

        /* Opstart-animation */
        .tile.intro .zoom { opacity: 0; }
        .tile.iv-focus.intro .zoom { filter: blur(20px); }
        .tile.intro .msg { display: none; }
        .intro-layer { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
        .intro-text {
            position: absolute;
            left: 4cqw; bottom: 4cqw;
            margin: 0;
            font: 500 clamp(8px, 1.9cqw, 13px)/1.7 ui-monospace, "Cascadia Mono", Consolas, "SF Mono", monospace;
            letter-spacing: 0.04em;
            white-space: pre;
            color: var(--pn-intro, #4fd8ff);
            text-shadow: 0 0 8px color-mix(in srgb, var(--pn-intro, #4fd8ff) 55%, transparent);
            transition: opacity 0.5s;
        }
        .intro-frame { position: absolute; inset: 0; width: 100%; height: 100%; transition: opacity 0.6s; }
        .intro-frame path {
            fill: none;
            stroke: var(--pn-intro, #4fd8ff);
            stroke-width: 1.5;
            stroke-linecap: round;
            stroke-dasharray: 1;
            stroke-dashoffset: 1;
            filter: drop-shadow(0 0 5px var(--pn-intro, #4fd8ff));
        }
        .intro-layer.draw .intro-frame path { stroke-dashoffset: 0; transition: stroke-dashoffset var(--pn-intro-d, 0.9s) cubic-bezier(0.6, 0, 0.2, 1); }
        .intro-layer.fade .intro-frame, .intro-layer.fade .intro-text { opacity: 0; }
        .intro-flash { position: absolute; inset: 0; background: var(--pn-intro, #4fd8ff); opacity: 0; }
        .tile.intro-reveal .intro-flash { animation: pn-flash 0.6s ease-out; }
        @keyframes pn-flash { 0% { opacity: 0.28; } 100% { opacity: 0; } }
        @container (max-width: 190px) { .intro-text { display: none; } }

        /* Opstarter, hvor selve billedet afsløres (klippes frem) */
        .tile.iv-scan.intro .zoom, .tile.iv-iris.intro .zoom, .tile.iv-tv.intro .zoom, .tile.iv-blinds.intro .zoom { opacity: 1; }
        .tile.iv-scan.intro .zoom { clip-path: inset(0 0 100% 0); }
        .tile.iv-iris.intro .zoom { clip-path: circle(0% at 50% 50%); }
        .tile.iv-tv.intro .zoom { clip-path: inset(49.6% 50% 49.6% 50%); filter: brightness(3); }
        .tile.iv-blinds.intro .zoom, .tile.iv-blinds.intro-reveal .zoom {
            --pn-s: 0px;
            -webkit-mask-image: repeating-linear-gradient(to bottom, #000 0, #000 var(--pn-s), transparent var(--pn-s), transparent 24px);
            mask-image: repeating-linear-gradient(to bottom, #000 0, #000 var(--pn-s), transparent var(--pn-s), transparent 24px);
        }
        .tile.iv-scan.intro-reveal .zoom { animation: pn-scan calc(var(--pn-intro-d, 0.9s) * 1.1) cubic-bezier(0.4, 0, 0.2, 1) forwards; }
        .tile.iv-iris.intro-reveal .zoom { animation: pn-iris calc(var(--pn-intro-d, 0.9s) * 1.1) cubic-bezier(0.3, 0.7, 0.2, 1) forwards; }
        .tile.iv-tv.intro-reveal .zoom { animation: pn-tv calc(var(--pn-intro-d, 0.9s) * 1.1) cubic-bezier(0.4, 0, 0.2, 1) forwards; }
        .tile.iv-blinds.intro-reveal .zoom { animation: pn-blinds calc(var(--pn-intro-d, 0.9s) * 1.1) cubic-bezier(0.4, 0, 0.2, 1) forwards; }
        @keyframes pn-scan { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes pn-iris { from { clip-path: circle(0% at 50% 50%); } to { clip-path: circle(75% at 50% 50%); } }
        @keyframes pn-tv {
            0% { clip-path: inset(49.6% 50% 49.6% 50%); filter: brightness(3); }
            35% { clip-path: inset(49.6% 0 49.6% 0); filter: brightness(3); }
            100% { clip-path: inset(0 0 0 0); filter: brightness(1); }
        }
        @keyframes pn-blinds { from { --pn-s: 0px; } to { --pn-s: 24px; } }
        .intro-bar {
            position: absolute;
            left: 0; right: 0; top: 0;
            height: 2px;
            opacity: 0;
            background: var(--pn-intro, #4fd8ff);
            box-shadow: 0 0 12px var(--pn-intro, #4fd8ff), 0 0 28px color-mix(in srgb, var(--pn-intro, #4fd8ff) 60%, transparent);
        }
        .tile.iv-scan.intro-reveal .intro-bar { animation: pn-bar calc(var(--pn-intro-d, 0.9s) * 1.1) cubic-bezier(0.4, 0, 0.2, 1) forwards; }
        @keyframes pn-bar { 0% { top: 0; opacity: 1; } 90% { opacity: 1; } 100% { top: calc(100% - 2px); opacity: 0; } }
        .tile.iv-scan .intro-flash, .tile.iv-iris .intro-flash, .tile.iv-tv .intro-flash, .tile.iv-blinds .intro-flash { display: none; }
        @media (prefers-reduced-motion: reduce) { .intro-layer { display: none; } }
    `;

    class PanoptesTile {
        constructor(card, idx, cam) {
            this.card = card;
            this.idx = idx;
            this.cam = cam;
            this.role = 'single';      // single | main | mini | grid
            this.streamIdx = 0;
            this.manual = null;        // stream valgt med kvalitetsknappen (overstyrer automatisk valg)
            this.state = 'loading';
            this.player = null;
            this.started = false;
            this.cleanups = [];
            this.resetZoom = null;
            this.fsIcon = null;
            this.intro = null;
            this._build();
        }

        get o() {
            return this.card._o;
        }

        get big() {
            return this.role === 'single' || this.role === 'main' || this.el.classList.contains('fs');
        }

        /* ---------- Opbygning ---------- */

        _build() {
            const o = this.o;
            const titleHtml = `<span class="title${o.titlePos === 'hidden' ? ' no-name' : ''}"><span class="name"></span><span class="status"></span></span>`;
            const side = {'top-left': 'left', 'top-right': 'right'}[o.titlePos] || 'center';
            const bottom = o.titlePos === 'bottom-center';
            const cl = q => o.camLabel ? `<span class="camlabel at-${q}"></span>` : '';

            const el = this.el = document.createElement('div');
            el.className = 'tile single';
            el.innerHTML = `
                <div class="player">
                    <div class="zoom"></div>
                    <div class="msg" hidden><div class="spinner"></div><div class="text"></div></div>
                    <div class="header">
                        <div class="h-left">${cl('top-left')}${!bottom && side === 'left' ? titleHtml : ''}</div>
                        <div class="h-center">${cl('top-center')}${!bottom && side === 'center' ? titleHtml : ''}</div>
                        <div class="h-right">${cl('top-right')}${!bottom && side === 'right' ? titleHtml : ''}${this._hasPanel() ? '<button class="cp-btn" type="button" aria-label="' + tr('tile.control_panel') + '"><ha-icon icon="mdi:tune-variant"></ha-icon></button>' : ''}<button class="quality" type="button" hidden></button>${this.card._carActive && this.card._carActive() && o.carPause ? '<button class="car-pause" type="button"><ha-icon icon="mdi:pause"></ha-icon></button>' : ''}</div>
                    </div>
                    ${bottom ? `<div class="bottom-title">${titleHtml}</div>` : ''}
                    ${o.camLabel ? `<div class="cl-b">${cl('bottom-left')}${cl('bottom-right')}</div><div class="cl-bc">${cl('bottom-center')}</div>` : ''}
                </div>`;
            // Nederste mærke ligger over den tekniske udlæsning og knapperne
            el.style.setProperty('--pn-clb', (o.readout.length ? (o.ui ? 58 : 30) : (o.ui ? 38 : 10)) + 'px');

            const q = sel => el.querySelector(sel);
            this.ui = {
                player: q('.player'),
                zoom: q('.zoom'),
                msg: q('.msg'),
                spinner: q('.msg .spinner'),
                text: q('.msg .text'),
                name: q('.name'),
                status: q('.status'),
                quality: q('.quality'),
            };
            this.ui.name.textContent = this.cam.name;
            const nameMode = o.camLabelText === 'name' && !this.cam.label;
            el.querySelectorAll('.camlabel').forEach(cl => {
                if (this.cam.label || nameMode) {
                    cl.innerHTML = '<b class="cl-n"></b>';
                    cl.firstChild.textContent = this.cam.label || this.cam.name || tr('camera_n', this.idx + 1);
                    if (nameMode) cl.classList.add('cl-name');
                } else {
                    cl.innerHTML = '<span class="cl-t">CAM</span> <b class="cl-n"></b>';
                    cl.querySelector('.cl-n').textContent = String(this.idx + 1).padStart(2, '0');
                }
            });

            this.ui.quality.addEventListener('click', ev => {
                ev.stopPropagation();
                this._cycleQuality();
            });

            const pb = this.ui.player.querySelector('.car-pause');
            if (pb) {
                pb.addEventListener('click', ev => {
                    ev.stopPropagation();
                    this.card._carTogglePause();
                });
            }

            // Klik: miniature bliver hovedkamera, gitterflise åbner fuldskærm
            this.ui.player.addEventListener('click', ev => {
                if (el.classList.contains('fs')) return;
                if (ev.target.closest && ev.target.closest('.quality, .car-pause, .controls, .ptz, .cp, .cp-btn')) return;
                if (this.role === 'mini') this.card._focusCamera(this.idx);
                else if (this.role === 'grid' && !el.classList.contains('fs')) this.enterFs();
            });
            el.addEventListener('keydown', ev => {
                if (ev.key === 'Enter' && this.role === 'mini' && !el.classList.contains('fs')) this.card._focusCamera(this.idx);
            });

            if (!this.cam.streams.length) {
                this.ui.spinner.hidden = true;
                this.ui.text.textContent = tr('tile.no_stream');
                this.ui.msg.hidden = false;
            }
        }

        start() {
            if (!this.cam.streams.length || this.started) return;
            this.started = true;
            this.streamIdx = this._wanted();
            this._updateQualityUi();
            this.state = 'loading';
            if (this.card._playIntro) this._introStart();
            this._buildPlayer();
            if (this.cam.ptz) this._buildPtz();
            if (this.o.ui) this._buildControls();
            if (this.o.readout.length) this._buildReadout();
            if (this.cam.control) this._buildControl();
            if (this.o.zoom) this._initZoom();
        }

        /* ---------- Kontrolpanel og privatliv ---------- */

        _hasPanel() {
            const c = this.cam.control;
            return !!c && this.o.panel && CONTROL_KEYS.some(k => c[k]);
        }

        _buildControl() {
            const c = this.cam.control;
            const player = this.ui.player;

            if (c.privacy && this.o.privacyCover !== 'none') {
                const v = this.o.privacyCover;
                const cover = document.createElement('div');
                cover.className = 'cover pc-' + v;
                cover.innerHTML = (PRIVACY_FX[v] ? '<canvas class="cv-canvas"></canvas>' : '') +
                    '<div class="cv-msg"><ha-icon icon="mdi:lock-outline"></ha-icon>' +
                    (v === 'clock' ? '<div class="cv-clock"></div>' : '') +
                    '<div class="cv-text">' + tr('tile.privacy_on') + '</div></div>';
                player.appendChild(cover);
                const idle = cover.querySelector('.cv-canvas');
                if (idle) freeCv(idle);   // et nyt lærred er 300x150 som standard; det bruges først, når animationen starter
                this.ui.cover = cover;
            }

            if (this._hasPanel()) {
                const cp = document.createElement('div');
                cp.className = 'cp';
                player.appendChild(cp);
                this.ui.cp = cp;
                this.ui.cpBtn = this.el.querySelector('.cp-btn');

                const setOpen = open => {
                    cp.classList.toggle('open', open);
                    this.ui.cpBtn.classList.toggle('on', open);
                };
                this.ui.cpBtn.addEventListener('click', ev => {
                    ev.stopPropagation();
                    setOpen(!cp.classList.contains('open'));
                });
                // Klik på billedet lukker panelet
                player.addEventListener('click', ev => {
                    if (!ev.target.closest || ev.target.closest('.cp, .cp-btn')) return;
                    setOpen(false);
                });
                cp.addEventListener('click', ev => {
                    const b = ev.target.closest && ev.target.closest('[data-act]');
                    if (!b) return;
                    ev.stopPropagation();
                    this._cpAct(b.dataset.act, b.dataset.k, b.dataset.v);
                });
                cp.addEventListener('change', ev => {
                    const sel = ev.target;
                    if (sel && sel.dataset && sel.dataset.sel) this._cpAct('opt', sel.dataset.sel, sel.value);
                });
            }

            this._cpSig = null;
            this._cpObjs = null;
            this.refreshControl();
        }

        _cpAct(act, key, val) {
            const h = this.card._hass;
            const id = this.cam.control && this.cam.control[key];
            if (!h || !id) return;
            if (act === 'toggle') h.callService(id.split('.')[0], 'toggle', {entity_id: id});
            else if (act === 'opt') h.callService('select', 'select_option', {entity_id: id, option: val});
        }

        /** Opdaterer panel og dækning ud fra entiteternes tilstand (kun når noget er ændret). */
        refreshControl() {
            const c = this.cam.control;
            const h = this.card._hass;
            if (!c || !h) return;
            // HA udskifter kun en entitets tilstandsobjekt, når noget i den ændrer sig. Er alle objekterne de samme som sidst, er der intet at gøre.
            const objs = CONTROL_KEYS.map(k => (c[k] && h.states[c[k]]) || null);
            if (this._cpObjs && objs.every((o, i) => o === this._cpObjs[i])) return;
            this._cpObjs = objs;
            const S = k => (c[k] && h.states[c[k]]) || null;
            const sig = CONTROL_KEYS.map(k => {
                const st = S(k);
                return st ? st.state + '|' + ((st.attributes && st.attributes.options) || []).join(',') : '-';
            }).join(';');
            if (sig === this._cpSig) return;
            this._cpSig = sig;

            const priv = !!S('privacy') && S('privacy').state === 'on';
            const patrolling = !!S('patrol') && S('patrol').state === 'on';
            this.el.classList.toggle('private', priv);
            this.el.classList.toggle('patrolling', patrolling);
            if (priv) this._fxStart();
            else this._fxStop();

            if (!this.ui.cp) return;
            const row = (icon, label, key, on) =>
                `<div class="cp-row"><ha-icon icon="${icon}"></ha-icon><span class="lbl">${label}</span><button class="tg${on ? ' on' : ''}" type="button" role="switch" aria-checked="${on}" aria-label="${label}" data-act="toggle" data-k="${key}"></button></div>`;
            const chips = (key, st, title) => {
                const opts = (st.attributes && st.attributes.options) || [];
                if (!opts.length) return '';
                const style = this.o.presetStyle === 'auto' ? (opts.length > 6 ? 'dropdown' : 'buttons') : this.o.presetStyle;
                if (key === 'patrol_mode' || style === 'buttons') {
                    return `<div><div class="cp-sub">${title}</div><div class="chips">${opts.map(o => `<button class="chip${o === st.state ? ' on' : ''}" type="button" data-act="opt" data-k="${key}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>`;
                }
                return `<div><div class="cp-sub">${title}</div><select data-sel="${key}">${opts.map(o => `<option value="${esc(o)}"${o === st.state ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
            };

            let html = '';
            if (S('privacy')) html += row('mdi:shield-lock-outline', tr('tile.cp.privacy'), 'privacy', priv);
            let more = '';
            if (S('preset')) more += chips('preset', S('preset'), tr('tile.cp.position'));
            if (S('patrol')) more += row('mdi:rotate-right', tr('tile.cp.patrol'), 'patrol', patrolling);
            if (S('patrol_mode')) more += chips('patrol_mode', S('patrol_mode'), tr('tile.cp.patrol_mode'));
            if (S('light')) more += row('mdi:light-flood-down', tr('tile.cp.light'), 'light', S('light').state === 'on');
            if (more) html += `<div class="sec-x">${more}</div>`;
            this.ui.cp.classList.toggle('private', priv);
            this.ui.cp.innerHTML = html || '<div class="cp-sub">' + tr('tile.cp.none') + '</div>';
        }

        /** Animationen i privatlivsdækningen. Kører kun, når kameraet er stort og i syne. */
        _fxStart() {
            const cover = this.ui.cover;
            if (!cover || this._fx) return;
            const v = this.o.privacyCover;

            if (v === 'clock') {
                const el = cover.querySelector('.cv-clock');
                const tick = () => {
                    el.textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
                };
                tick();
                const id = setInterval(tick, 5000);
                this._fx = {stop: () => clearInterval(id)};
                return;
            }

            const fx = PRIVACY_FX[v];
            const cv = cover.querySelector('.cv-canvas');
            if (!fx || !cv) return;
            if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

            const g = cv.getContext('2d');
            const st = {};
            const col = (getComputedStyle(cv).color) || '#4fd8ff';
            let w = 0;
            let h = 0;
            let last = 0;
            let t = 0;
            let raf = 0;
            let visible = true;
            let ready = false;

            // Animationen kører kun, mens flisen er stor (eller små fliser har dækslet slået til) og i syne.
            // Ellers står loopen stille og lærredets pixelhukommelse er frigivet (Android WebView rydder ellers sent op).
            const active = () => !document.hidden && visible && (this.big || this.o.privacySmall);
            const resize = () => {
                // Layoutstørrelse (ikke getBoundingClientRect, som påvirkes af glideanimationen mellem kameraer)
                w = this.ui.player.clientWidth;
                h = this.ui.player.clientHeight;
                if (!w || !h) return;
                const dpr = privacyDpr(this.o.privacyQuality);
                cv.width = w * dpr;
                cv.height = h * dpr;
                g.setTransform(dpr, 0, 0, dpr, 0, 0);
                fx.init(st, w, h, g);
                ready = true;
            };
            let sync;
            const frame = ts => {
                raf = requestAnimationFrame(frame);
                if (!active()) {
                    sync();
                    return;
                }
                // Størrelsen tjekkes her, fordi fliserne skifter størrelse, når et andet kamera bliver hovedkamera
                if (this.ui.player.clientWidth !== w || this.ui.player.clientHeight !== h) resize();
                if (!ready) return;
                if (last && ts - last < (this.big ? 33 : 50)) return;
                const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0.033;
                last = ts;
                t += dt;
                fx.draw(g, w, h, t, dt, st, col);
            };
            sync = () => {
                if (active()) {
                    if (raf) return;
                    last = 0;
                    resize();
                    if (ready) raf = requestAnimationFrame(frame);
                } else {
                    if (raf) cancelAnimationFrame(raf);
                    raf = 0;
                    last = 0;
                    ready = false;
                    freeCv(cv);
                }
            };

            const ro = 'ResizeObserver' in window ? new ResizeObserver(() => sync()) : null;
            if (ro) ro.observe(this.ui.player);
            const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
                visible = es.some(e => e.isIntersecting);
                sync();
            }) : null;
            if (io) io.observe(this.el);
            document.addEventListener('visibilitychange', sync);
            sync();
            this._fx = {
                sync,
                stop: () => {
                    cancelAnimationFrame(raf);
                    raf = 0;
                    if (ro) ro.disconnect();
                    if (io) io.disconnect();
                    document.removeEventListener('visibilitychange', sync);
                    ready = false;
                    freeCv(cv);
                },
            };
        }

        _fxStop() {
            if (this._fx) {
                this._fx.stop();
                this._fx = null;
            }
        }

        /** Teknisk udlæsning (forbindelse, opløsning, fps, bitrate, klokkeslæt) nederst på billedet. */
        _buildReadout() {
            const items = this.o.readout;
            const el = document.createElement('div');
            el.className = 'readout' + (this.o.ui ? ' has-ui' : '');
            el.innerHTML = '<span class="ro-tech"></span><span class="ro-clock"></span>';
            this.ui.player.appendChild(el);
            const tech = el.querySelector('.ro-tech');
            const clock = el.querySelector('.ro-clock');
            const last = {t: 0, frames: 0, bytes: 0};
            const rate = bps => bps >= 1e6 ? (bps / 1e6).toFixed(1) + ' Mbps' : Math.round(bps / 1e3) + ' kbps';

            const tick = async () => {
                if (document.hidden) return;
                if (this.player && this.player._active === false) return;   // kortet er uden for syne
                if (!this.big) {
                    // Udlæsningen er skjult på små fliser, så de bruger ingen tid på den
                    if (tech.textContent) tech.textContent = '';
                    return;
                }
                if (items.includes('clock')) {
                    clock.textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
                }
                const p = this.player;
                if (!p || !p.video) {
                    tech.textContent = '';
                    return;
                }
                const v = p.video;
                const now = performance.now();
                const dt = (now - last.t) / 1000;
                const parts = [];
                if (items.includes('connection') && this.mode) parts.push(this.mode);
                if (items.includes('resolution') && v.videoWidth) parts.push(`${v.videoWidth}×${v.videoHeight}`);
                // WebRTC: statistik fra forbindelsen (Firefox giver ikke billedtal på video-elementet ved WebRTC)
                let bytes = null;
                let frames = null;
                let sfps = null;
                if (p.pc && (items.includes('fps') || items.includes('bitrate'))) {
                    try {
                        (await p.pc.getStats()).forEach(r => {
                            if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'video') {
                                bytes = r.bytesReceived;
                                frames = r.framesDecoded;
                                sfps = r.framesPerSecond;
                            }
                        });
                    } catch (e) {
                        // statistik ikke tilgængelig
                    }
                } else if (p.ws) {
                    bytes = p.bytes;
                }
                if (items.includes('fps')) {
                    let fps = null;
                    if (typeof sfps === 'number' && sfps > 0) {
                        fps = sfps;
                    } else {
                        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
                        const f = frames != null ? frames : (q ? q.totalVideoFrames : 0);
                        if (last.t && last.frames && f >= last.frames && dt > 0) fps = (f - last.frames) / dt;
                        last.frames = f;
                    }
                    if (fps !== null) parts.push(`${Math.round(fps)} fps`);
                }
                if (items.includes('bitrate') && bytes != null) {
                    if (last.t && last.bytes && bytes >= last.bytes && dt > 0) parts.push(rate((bytes - last.bytes) * 8 / dt));
                    last.bytes = bytes;
                }
                last.t = now;
                tech.textContent = parts.join(' · ');
            };
            const id = setInterval(tick, 1000);
            tick();
            this._roTick = tick;   // kaldes, når flisen bliver stor, så udlæsningen ikke står tom i op til et sekund
            this.cleanups.push(() => {
                clearInterval(id);
                this._roTick = null;
                el.remove();
            });
        }

        /** Kortet er gået i eller ud af fuldskærm: marker flisen, vis HD og nulstil zoom ved afslutning. */
        setFs(on) {
            if (this.el.classList.contains('fs') === on) return;
            this.el.classList.toggle('fs', on);
            this._syncControls();
            if (this._fx && this._fx.sync) this._fx.sync();
            if (this._roTick) this._roTick();
            if (this.fsIcon) this.fsIcon.icon = on ? 'mdi:fullscreen-exit' : 'mdi:fullscreen';
            if (!on && !this.big && this.resetZoom) this.resetZoom();
            this.syncQuality();
        }

        destroy() {
            if (this._swapFxEnd) this._swapFxEnd();
            this._swapEnd();
            this._fxStop();
            this._introAbort();
            this.cleanups.forEach(fn => fn());
            this.cleanups = [];
            if (this.player) {
                this.player.destroy();
                this.player = null;
            }
            this.started = false;
        }

        /* ---------- Rolle og kvalitet ---------- */

        /** Browserens egne kontroller bruges kun med ui: browser, og kun på det store kamera, i enkelt og i fuldskærm. Små fliser får dem aldrig. */
        _syncControls() {
            const v = this.player && this.player.video;
            if (!v) return;
            v.controls = this.o.uiMode === 'browser' && (this.role === 'single' || this.role === 'main' || this.el.classList.contains('fs'));
        }

        setRole(role) {
            if (this.role === role) return;
            this.role = role;
            this.el.classList.remove('single', 'main', 'mini', 'grid');
            this.el.classList.add(role);
            this._syncControls();
            if (this._fx && this._fx.sync) this._fx.sync();
            if (this._roTick) this._roTick();

            if (role === 'mini') {
                this.el.tabIndex = 0;
                this.el.setAttribute('role', 'button');
                this.el.setAttribute('aria-label', this.cam.name || tr('camera'));
            } else {
                this.el.removeAttribute('tabindex');
                this.el.removeAttribute('role');
                this.el.removeAttribute('aria-label');
            }

            if (!this.big) {
                this.manual = null;
                if (this.resetZoom) this.resetZoom();
            }
            this.syncQuality();
        }

        _wanted() {
            const n = this.cam.streams.length;
            if (this.manual !== null && this.manual < n) return this.manual;
            if (n < 2 || !this.o.autoQuality) return 0;
            return this.big ? 0 : n - 1;   // første stream = HD, sidste = SD
        }

        _label(i) {
            const s = this.cam.streams[i];
            return (s && s.name) || `S${i}`;
        }

        _updateQualityUi() {
            const btn = this.ui.quality;
            btn.hidden = this.cam.streams.length < 2;
            btn.textContent = this._label(this.streamIdx);
            const hr = btn.parentNode;
            if (hr) hr.classList.toggle('q2', !btn.hidden);
        }

        syncQuality() {
            if (!this.cam.streams.length) return;
            const want = this._wanted();
            if (want === this.streamIdx) return;
            this.streamIdx = want;
            this._updateQualityUi();
            if (this.started) this._applyAndReload();
        }

        _cycleQuality() {
            const n = this.cam.streams.length;
            if (n < 2) return;
            this.manual = (this.streamIdx + 1) % n;
            this.streamIdx = this.manual;
            this._updateQualityUi();
            this._applyAndReload();
        }

        /** Tager et stillbillede af den kørende video (eller null, hvis der ikke er et billede endnu). */
        _snapshot() {
            const v = this.player && this.player.video;
            if (!v || !v.videoWidth || v.readyState < 2) return null;
            try {
                const cv = snapCanvas();
                const max = this.o.stillMax;
                const k = max && v.videoWidth > max ? max / v.videoWidth : 1;
                cv.width = Math.round(v.videoWidth * k);
                cv.height = Math.round(v.videoHeight * k);
                cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
                cv.className = 'snap';
                cv.style.objectFit = getComputedStyle(v).objectFit || 'contain';
                DBG.n.snap++;
                return cv;
            } catch (e) {
                return null;
            }
        }

        /**
         * Stillbillede af privatlivsdækslet (en ensfarvet plade, kun 16 px bredt) til skifteeffekter, når det nye kamera har privatliv slået til,
         * men ikke har noget levende billede (stoppet kamera). Et privat kamera viser jo dækslet og ikke videoen.
         */
        _coverStill(like) {
            try {
                const cv = snapCanvas();
                cv.width = 16;
                cv.height = Math.max(1, Math.round(16 * (like.height || 9) / (like.width || 16)));
                const g = cv.getContext('2d');
                g.fillStyle = '#000';
                g.fillRect(0, 0, cv.width, cv.height);
                const col = this.ui.cover ? getComputedStyle(this.ui.cover).backgroundColor : '';
                if (col) {
                    g.fillStyle = col;
                    g.fillRect(0, 0, cv.width, cv.height);
                }
                cv.className = 'snap';
                cv.style.objectFit = 'cover';
                return cv;
            } catch (e) {
                return null;
            }
        }

        /** Holder et frosset billede over videoen, til den nye stream afspiller, og skifter så med en effekt. */
        beginSwap(snap, effect, dir, pulse) {
            if (!snap) return;
            DBG.n.swap++;
            this._swapEnd();
            this._swap = {
                snap, effect, dir: dir || 1, pulse: !!pulse,
                timer: setTimeout(() => this._swapEnd(), 8000),
            };
            this.ui.zoom.appendChild(snap);
            this.el.classList.add('frozen');
        }

        _swapEnd() {
            const sw = this._swap;
            if (!sw) return;
            clearTimeout(sw.timer);
            this._swap = null;
            sw.snap.remove();
            this.ui.zoom.style.perspective = '';
            this.el.classList.remove('frozen');
        }

        _swapReveal() {
            const sw = this._swap;
            if (!sw) return;
            this._swap = null;
            clearTimeout(sw.timer);
            this.el.classList.remove('frozen');
            const snap = sw.snap;
            const done = () => {
                snap.remove();
                this.ui.zoom.style.perspective = '';
            };
            if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
                done();
                return;
            }
            const sp = this.o.introSpeed;
            const d = (sw.pulse ? 380 : 520) * sp;
            const fx = sw.pulse ? 'soft' : sw.effect;

            if (sw.pulse) {
                const q = this.ui.quality;
                q.classList.remove('pulse');
                void q.offsetWidth;
                q.classList.add('pulse');
                setTimeout(() => q.classList.remove('pulse'), 900);
            }
            this._runEffect(snap, this.player, this.ui.zoom, fx, sw.dir, d, done);
        }

        /**
         * Effekt, hvor et frosset billede (snap) afløses af det nye indhold (incoming).
         * host er det element, snap ligger i (og som får perspektiv ved Vend).
         */
        _runEffect(snap, incoming, host, fx, dir, d, done, next) {
            const ease = 'cubic-bezier(0.4, 0, 0.2, 1)';
            const pl = incoming;
            if (STILL_FX.includes(fx)) {
                if (this._runStillFx(fx, snap, pl, host, dir, d, done, next)) return;
                fx = 'soft';
            }
            setTimeout(done, d + 500);   // reserve, hvis en animation ikke afsluttes (fx skjult fane)

            if (fx === 'slide') {
                const x = dir >= 0 ? 100 : -100;
                snap.animate([{transform: 'translateX(0)'}, {transform: `translateX(${-x}%)`}], {duration: d, easing: ease, fill: 'forwards'}).onfinish = done;
                pl.animate([{transform: `translateX(${x}%)`}, {transform: 'translateX(0)'}], {duration: d, easing: ease});
            } else if (fx === 'zoom') {
                snap.animate([{transform: 'scale(1)', opacity: 1}, {transform: 'scale(1.18)', opacity: 0}], {duration: d, easing: ease, fill: 'forwards'}).onfinish = done;
                pl.animate([{transform: 'scale(0.9)', opacity: 0}, {transform: 'scale(1)', opacity: 1}], {duration: d, easing: ease});
            } else if (fx === 'flip') {
                // Den levende video roteres ikke i 3D (Firefox tegner så sorte og ensfarvede blokke, især i fuldskærm).
                // I stedet vendes to stillbilleder, mens videoen står skjult nedenunder.
                const snap2 = this._snapshot();
                const parent = snap.parentNode;
                let showLive = () => {};
                const finish = () => {
                    showLive();
                    if (snap2) snap2.remove();
                    done();
                };
                if (snap2 && parent) {
                    showLive = this._hideLive(pl);
                    // Perspektivet ligger i selve transformationen: tydelig dybde, kortet trækkes lidt tilbage og mørkner, når det drejer væk
                    const w = host.clientWidth || snap.width;
                    const persp = Math.round(Math.max(600, w * 0.8));
                    const back = Math.round(w * 0.1);
                    const tf = (deg, z) => `perspective(${persp}px) translateZ(${z}px) rotateY(${deg}deg)`;
                    snap2.style.zIndex = '2';
                    snap2.style.transform = tf(-90, -back);
                    parent.appendChild(snap2);
                    snap.animate([
                        {transform: tf(0, 0), filter: 'brightness(1)'},
                        {transform: tf(90, -back), filter: 'brightness(0.45)'},
                    ], {duration: d / 2, easing: 'ease-in', fill: 'forwards'});
                    snap2.animate([
                        {transform: tf(-90, -back), filter: 'brightness(0.45)'},
                        {transform: tf(0, 0), filter: 'brightness(1)'},
                    ], {duration: d / 2, delay: d / 2, easing: 'ease-out', fill: 'both'});
                } else {
                    // Intet billede at vende endnu: flad vending uden 3D
                    snap.animate([{transform: 'scaleX(1)'}, {transform: 'scaleX(0)'}], {duration: d / 2, easing: 'ease-in', fill: 'forwards'});
                    pl.animate([{transform: 'scaleX(0)'}, {transform: 'scaleX(1)'}], {duration: d / 2, delay: d / 2, easing: 'ease-out', fill: 'backwards'});
                }
                setTimeout(finish, d + 60);
            } else if (fx === 'pixel') {
                const w = snap.width;
                const h = snap.height;
                const src = document.createElement('canvas');
                src.width = w;
                src.height = h;
                src.getContext('2d').drawImage(snap, 0, 0);
                const small = document.createElement('canvas');
                const g = snap.getContext('2d');
                const T = d * 0.45;
                const t0 = performance.now();
                const phase2 = () => {
                    freeCv(src);
                    freeCv(small);
                    snap.animate([{opacity: 1}, {opacity: 0}], {duration: d * 0.55, easing: ease, fill: 'forwards'}).onfinish = done;
                    pl.animate([{filter: 'blur(10px)', opacity: 0.2}, {filter: 'blur(0)', opacity: 1}], {duration: d * 0.55, easing: ease});
                };
                const step = ts => {
                    const k = Math.min(1, (ts - t0) / T);
                    const f = Math.max(1, Math.round(1 + k * Math.min(w, h) / 22));
                    small.width = Math.max(1, Math.ceil(w / f));
                    small.height = Math.max(1, Math.ceil(h / f));
                    small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
                    g.imageSmoothingEnabled = false;
                    g.clearRect(0, 0, w, h);
                    g.drawImage(small, 0, 0, small.width, small.height, 0, 0, w, h);
                    if (k < 1) requestAnimationFrame(step);
                    else phase2();
                };
                requestAnimationFrame(step);
            } else {
                snap.animate([{opacity: 1}, {opacity: 0}], {duration: d, easing: ease, fill: 'forwards'}).onfinish = done;
            }
        }


        /**
         * Skifteeffekter, der bruger stillbilleder af både det gamle og det nye kamera. Den levende video røres ikke,
         * så der kommer ingen 3D-fejl i Firefox. Returnerer false, hvis effekten ikke kan køre (så bruges Blød).
         */
        _runStillFx(fx, a, pl, host, dir, d, done, next) {
            const parent = a.parentNode;
            const W = parent && parent.clientWidth;
            const H = parent && parent.clientHeight;
            const b = next || this._snapshot();
            if (!parent || !W || !H || !b) return false;

            // Lærredseffekter kan ikke bruge var(--primary-color): find den faktiske farve først
            let acc = this.o.introColor;
            try {
                const probe = document.createElement('span');
                probe.style.cssText = 'display:none';
                probe.style.color = acc;
                parent.appendChild(probe);
                acc = getComputedStyle(probe).color || acc;
                probe.remove();
            } catch (e) { /* bruger værdien som den er */ }
            const T = d * (STILL_T[fx] || 1);
            const sgn = dir >= 0 ? 1 : -1;
            const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

            // Lærredseffekter: begge billeder skaleres til arbejdsstørrelse og tegnes frame for frame
            let canvas = null;
            if (FX_CANVAS[fx]) {
                try {
                    const cw = Math.min(W, 720);
                    const ch = Math.max(1, Math.round(H * cw / W));
                    const fit = src => {
                        const c = document.createElement('canvas');
                        c.width = cw;
                        c.height = ch;
                        const g = c.getContext('2d');
                        g.fillStyle = '#000';
                        g.fillRect(0, 0, cw, ch);
                        const s = (src.style.objectFit === 'cover' ? Math.max : Math.min)(cw / src.width, ch / src.height);
                        g.drawImage(src, (cw - src.width * s) / 2, (ch - src.height * s) / 2, src.width * s, src.height * s);
                        return c;
                    };
                    const A = fit(a);
                    const B = fit(b);
                    canvas = {cw, ch, A, B, st: FX_CANVAS[fx].init(A, B, cw, ch, acc)};
                } catch (e) {
                    return false;
                }
            }

            if (this._swapFxEnd) this._swapFxEnd();
            const z = a.style.zIndex;
            let showLive = () => {};
            const extras = [];
            let over = false;
            let raf = 0;
            const timers = [];
            const finish = () => {
                if (over) return;
                over = true;
                cancelAnimationFrame(raf);
                timers.forEach(clearTimeout);
                showLive();
                extras.forEach(e => e.remove());
                if (canvas) {
                    freeCv(canvas.A);
                    freeCv(canvas.B);
                    if (canvas.st && canvas.st.n) freeCv(canvas.st.n);
                }
                if (this._swapFxEnd === finish) this._swapFxEnd = null;
                done();
            };
            this._swapFxEnd = finish;
            timers.push(setTimeout(finish, T + 400));
            const add = (el, below) => {
                el.style.zIndex = z;
                extras.push(el);
                if (below) parent.insertBefore(el, a);
                else parent.appendChild(el);
                return el;
            };
            const an = (el, frames, opts) => el.animate(frames, Object.assign({duration: T, easing: EASE, fill: 'both'}, opts));
            const box = css => {
                const el = document.createElement('div');
                el.style.cssText = 'position:absolute;pointer-events:none;' + css;
                return el;
            };
            showLive = this._hideLive(pl);
            const endSoon = () => timers.push(setTimeout(finish, T + 60));

            if (canvas) {
                const cv = add(snapCanvas());
                cv.className = 'snap';
                cv.width = canvas.cw;
                cv.height = canvas.ch;
                const g = cv.getContext('2d');
                const fxo = FX_CANVAS[fx];
                fxo.draw(g, canvas.A, canvas.B, 0, canvas.cw, canvas.ch, canvas.st);
                const t0 = performance.now();
                const step = ts => {
                    if (over) return;
                    const k = Math.max(0, Math.min(1, (ts - t0) / T));
                    fxo.draw(g, canvas.A, canvas.B, k, canvas.cw, canvas.ch, canvas.st);
                    if (k < 1) raf = requestAnimationFrame(step);
                    else finish();
                };
                raf = requestAnimationFrame(step);
                return true;
            }

            add(b, fx === 'roll' || fx === 'tint');

            if (fx === 'cube') {
                const P = Math.round(W * 1.8);
                const tf = deg => `perspective(${P}px) translateZ(${-W / 2}px) rotateY(${deg}deg) translateZ(${W / 2}px)`;
                a.style.backfaceVisibility = b.style.backfaceVisibility = 'hidden';
                an(a, [{transform: tf(0), filter: 'brightness(1)'}, {transform: tf(-90 * sgn), filter: 'brightness(0.5)'}], {easing: 'cubic-bezier(0.65, 0, 0.35, 1)'});
                an(b, [{transform: tf(90 * sgn), filter: 'brightness(0.5)'}, {transform: tf(0), filter: 'brightness(1)'}], {easing: 'cubic-bezier(0.65, 0, 0.35, 1)'});
                endSoon();
            } else if (fx === 'push') {
                an(a, [{transform: 'translateX(0) scale(1)', filter: 'brightness(1)'}, {transform: `translateX(${-30 * sgn}%) scale(0.94)`, filter: 'brightness(0.4)'}]);
                an(b, [{transform: `translateX(${100 * sgn}%)`}, {transform: 'translateX(0)'}]);
                endSoon();
            } else if (fx === 'spin') {
                an(a, [{transform: 'rotate(0deg) scale(1)', opacity: 1, offset: 0}, {transform: `rotate(${-5 * sgn}deg) scale(0.75)`, opacity: 1, offset: 0.5}, {transform: `rotate(${-10 * sgn}deg) scale(0.55)`, opacity: 0, offset: 1}]);
                an(b, [{transform: `rotate(${10 * sgn}deg) scale(1.6)`, opacity: 0, offset: 0}, {transform: `rotate(${5 * sgn}deg) scale(1.25)`, opacity: 0, offset: 0.2}, {transform: 'rotate(0deg) scale(1)', opacity: 1, offset: 1}]);
                endSoon();
            } else if (fx === 'roll') {
                const rh = Math.max(24, Math.round(H * 0.12));
                const roll = add(box(`left:0;top:0;width:100%;height:${rh}px;background:linear-gradient(to bottom,rgba(0,0,0,.65),rgba(255,255,255,.55) 30%,rgba(255,255,255,.15) 55%,rgba(0,0,0,.7));box-shadow:0 6px 18px rgba(0,0,0,.5)`));
                if (sgn > 0) {
                    an(a, [{clipPath: 'inset(0 0 0% 0)'}, {clipPath: 'inset(0 0 100% 0)'}], {easing: 'linear'});
                    an(roll, [{transform: `translateY(${H - rh / 2}px)`}, {transform: `translateY(${-rh / 2}px)`}], {easing: 'linear'});
                } else {
                    an(a, [{clipPath: 'inset(0% 0 0 0)'}, {clipPath: 'inset(100% 0 0 0)'}], {easing: 'linear'});
                    an(roll, [{transform: `translateY(${-rh / 2}px)`}, {transform: `translateY(${H - rh / 2}px)`}], {easing: 'linear'});
                }
                endSoon();
            } else if (fx === 'blur') {
                an(a, [{filter: 'blur(0px)', opacity: 1, transform: 'scale(1)'}, {filter: 'blur(18px)', opacity: 0, transform: 'scale(1.05)'}]);
                an(b, [{filter: 'blur(18px)', opacity: 0, transform: 'scale(1.05)'}, {filter: 'blur(0px)', opacity: 1, transform: 'scale(1)'}]);
                endSoon();
            } else if (fx === 'wash') {
                const bw = Math.round(W * 0.45);
                const band = add(box(`top:0;left:0;width:${bw}px;height:100%;mix-blend-mode:screen;background:linear-gradient(90deg,transparent,${acc} 42%,#fff 50%,${acc} 58%,transparent)`));
                const from = sgn > 0 ? -bw / 2 : W + bw / 2 - bw;
                const to = sgn > 0 ? W - bw / 2 : -bw / 2;
                an(b, sgn > 0 ? [{clipPath: 'inset(0 100% 0 0)'}, {clipPath: 'inset(0 0% 0 0)'}] : [{clipPath: 'inset(0 0 0 100%)'}, {clipPath: 'inset(0 0 0 0%)'}], {easing: 'linear'});
                an(band, [{transform: `translateX(${from}px)`, opacity: 0, offset: 0}, {opacity: 1, offset: 0.12}, {opacity: 1, offset: 0.88}, {transform: `translateX(${to}px)`, opacity: 0, offset: 1}], {easing: 'linear'});
                endSoon();
            } else if (fx === 'tint') {
                const wash = add(box(`inset:0;background:${acc};mix-blend-mode:color`));
                an(a, [{filter: 'grayscale(0) contrast(1)', opacity: 1, offset: 0}, {filter: 'grayscale(1) contrast(1.15)', opacity: 1, offset: 0.5}, {filter: 'grayscale(1) contrast(1.15)', opacity: 0, offset: 1}], {easing: 'linear'});
                an(b, [{filter: 'grayscale(1) contrast(1.15)', offset: 0}, {filter: 'grayscale(1) contrast(1.15)', offset: 0.5}, {filter: 'grayscale(0) contrast(1)', offset: 1}], {easing: 'linear'});
                an(wash, [{opacity: 0, offset: 0}, {opacity: 0.85, offset: 0.4}, {opacity: 0.85, offset: 0.6}, {opacity: 0, offset: 1}], {easing: 'linear'});
                endSoon();
            }
            return true;
        }

        /** Skjuler den levende video uden opblænding (.zoom har en overgang på opacity, som gav et sort blink). Returnerer en funktion, der viser den igen. */
        _hideLive(pl) {
            const op = pl.style.opacity;
            const tr = pl.style.transition;
            pl.style.transition = 'none';
            pl.style.opacity = '0';
            return () => {
                pl.style.opacity = op;
                void pl.offsetWidth;
                pl.style.transition = tr;
            };
        }

        /** Fokusskift: det gamle hovedkameras billede lægges over det nye og afløses med en effekt med det samme. */
        playTransition(snap, fx, dir, next) {
            if (!snap || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
            const player = this.ui.player;
            snap.style.zIndex = '1';
            player.appendChild(snap);
            const done = () => {
                snap.remove();
                player.style.perspective = '';
            };
            if (next && this.player && this.player.video) next.style.objectFit = getComputedStyle(this.player.video).objectFit || 'contain';
            this._runEffect(snap, this.ui.zoom, player, fx, dir || 1, 520 * this.o.introSpeed, done, next);
        }

        _applyAndReload() {
            const snap = this._snapshot();
            if (snap) this.beginSwap(snap, 'soft', 0, true);
            this.state = 'loading';
            this._showLoading();
            this._applyStream();
            this.player.reload();
        }

        _applyStream() {
            const s = this.cam.streams[this.streamIdx];
            this.player.setStream({
                url: s.url,
                entity: s.entity,
                mode: s.mode || this.o.mode,
                media: s.media || this.o.media,
            });
        }

        /* ---------- Player ---------- */

        _buildPlayer() {
            const o = this.o;
            const p = document.createElement('panoptes-player');
            p.background = o.background;
            p.visibilityThreshold = o.pause ? o.threshold : 0;
            p.visibilityTarget = this.ui.player;
            p.server = o.server;
            p.setPoster(o.poster);
            this.player = p;
            this._applyStream();
            p.init();
            p.video.muted = o.muted;
            this._syncControls();
            if (o.hidePip) {
                p.video.disablePictureInPicture = true;
                p.video.setAttribute('disablepictureinpicture', '');
            }
            if (this.card._hass) p.hass = this.card._hass;

            p.addEventListener('status', ev => this._onStatus(ev.detail));
            p.video.addEventListener('waiting', () => this._showLoading());
            p.video.addEventListener('playing', () => {
                this.ui.msg.hidden = true;
                if (this._swap) this._swapReveal();
                if (this.intro) {
                    this.intro.playing = true;
                    this._introCheck();
                }
            });

            this.ui.zoom.appendChild(p);
        }

        _showLoading() {
            this.ui.spinner.hidden = false;
            this.ui.text.textContent = '';
            this.ui.msg.hidden = false;
        }

        _onStatus({mode, text}) {
            // Sene fejlbeskeder efter at streamen kører (fx fra reserve-metoder) ignoreres
            if (mode === 'error' && this.state !== 'loading') return;

            if (mode === 'loading') {
                this.state = 'loading';
                this._showLoading();
                this.ui.status.textContent = '';
            } else if (mode === 'error') {
                this._swapEnd();
                this._introAbort();
                this.state = 'error';
                this.ui.spinner.hidden = true;
                this.ui.text.textContent = text || tr('tile.error');
                this.ui.msg.hidden = false;
            } else {
                this.state = 'live';
                this.mode = String(mode || '').toUpperCase();
                if (this.intro) this.intro.mode = String(mode || '').toUpperCase();
                this.ui.status.textContent = this.o.showStatus ? mode : '';
            }
        }

        /* ---------- Opstart-animation ---------- */

        _introStart() {
            const variant = this.o.intro;
            if (variant === 'none' || !this.cam.streams.length) return;
            if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

            const sp = this.o.introSpeed;
            const delay = this.idx * 220 * sp;   // ved flere kameraer starter de efter hinanden
            const I = this.intro = {variant, sp, delay, playing: false, minDone: false, ended: false, mode: '', lines: [], timers: []};
            const after = (ms, fn) => I.timers.push(setTimeout(fn, ms));

            const layer = I.layer = document.createElement('div');
            layer.className = 'intro-layer';
            layer.innerHTML = '<svg class="intro-frame"></svg><pre class="intro-text"></pre><div class="intro-bar"></div><div class="intro-flash"></div>';
            this.ui.player.appendChild(layer);
            this.el.classList.add('intro', 'iv-' + variant);
            this.el.style.setProperty('--pn-intro-d', (0.9 * sp) + 's');

            if (variant === 'frame') after(delay + 100, () => this._introFrame());

            if (variant === 'boot') {
                const nm = (this.cam.name || tr('camera_n', this.idx + 1)).toUpperCase();
                const st = this.cam.streams[this.streamIdx] || {};
                const src = String(st.url || st.entity || '').slice(0, 28);
                [`PANOPTES // ${nm}`, tr('tile.boot_connecting', src)].forEach((t, i) => {
                    after(delay + (250 + i * 420) * sp, () => this._introLine(t));
                });
            }

            after(delay + INTRO_MIN[variant] * sp, () => {
                I.minDone = true;
                this._introCheck();
            });
            // Giver op efter 9 sekunder, så et kamera uden forbindelse ikke bliver skjult
            after(delay + 9000, () => {
                I.playing = true;
                I.minDone = true;
                this._introCheck();
            });
        }

        _introLine(t) {
            const I = this.intro;
            if (!I) return;
            I.lines.push(t);
            I.layer.querySelector('.intro-text').textContent = I.lines.join('\n');
        }

        _introFrame() {
            const I = this.intro;
            if (!I) return;
            const w = this.ui.player.clientWidth;
            const h = this.ui.player.clientHeight;
            if (!w || !h) return;
            let r = parseFloat(getComputedStyle(this.el).borderTopLeftRadius) || 0;
            if (!r && this.card._wall && this.card._wall.parentElement) {
                r = parseFloat(getComputedStyle(this.card._wall.parentElement).borderTopLeftRadius) || 0;
            }
            const o = 1;
            r = clamp(r, 0, Math.min(w, h) / 2 - o);
            const d = `M${o + r},${o}H${w - o - r}A${r},${r} 0 0 1 ${w - o},${o + r}V${h - o - r}A${r},${r} 0 0 1 ${w - o - r},${h - o}H${o + r}A${r},${r} 0 0 1 ${o},${h - o - r}V${o + r}A${r},${r} 0 0 1 ${o + r},${o}Z`;
            const svg = I.layer.querySelector('.intro-frame');
            svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
            svg.innerHTML = `<path d="${d}" pathLength="1"/>`;
            void svg.getBoundingClientRect();   // tvinger beregning, så linjen tegnes ind i stedet for at stå færdig
            I.layer.classList.add('draw');
        }

        /** Billedet vises, når animationen har kørt mindst sin tid, og streamen faktisk afspiller. */
        _introCheck() {
            const I = this.intro;
            if (!I || I.ended || !I.minDone || !I.playing) return;
            I.ended = true;
            if (I.variant === 'boot') this._introLine(`${I.mode || 'LIVE'} OK`);
            I.timers.push(setTimeout(() => this._introReveal(), I.variant === 'boot' ? 320 * I.sp : 0));
        }

        _introReveal() {
            const I = this.intro;
            if (!I) return;
            this.el.classList.remove('intro');
            this.el.classList.add('intro-reveal');
            I.layer.classList.add('fade');
            I.timers.push(setTimeout(() => this._introAbort(), Math.max(1300, 1300 * I.sp)));
        }

        /** Rydder op (også ved fejl, så fejlbeskeden kan ses). */
        _introAbort() {
            const I = this.intro;
            if (!I) return;
            I.timers.forEach(clearTimeout);
            if (I.layer) I.layer.remove();
            this.el.classList.remove('intro', 'intro-reveal', 'iv-' + I.variant);
            this.el.style.removeProperty('--pn-intro-d');
            this.intro = null;
        }

        /* ---------- Fuldskærm ---------- */

        enterFs() {
            if (this.card._enterFs(this.idx)) return;
            const v = this.player && this.player.video;
            if (v && v.webkitEnterFullscreen) {
                try {
                    v.webkitEnterFullscreen();
                } catch (e) {
                    console.warn(e);
                }
            }
        }

        /* ---------- Egne knapper ---------- */

        _buildControls() {
            const player = this.ui.player;
            const video = this.player.video;

            player.insertAdjacentHTML('beforeend', `
                <div class="controls">
                    <ha-icon class="fullscreen" icon="mdi:fullscreen"></ha-icon>
                    <ha-icon class="screenshot" icon="mdi:camera"></ha-icon>
                    <ha-icon class="pip" icon="mdi:picture-in-picture-bottom-right"></ha-icon>
                    <span class="space"></span>
                    <ha-icon class="play" icon="mdi:play" hidden></ha-icon>
                    <ha-icon class="volume" icon="mdi:volume-high" hidden></ha-icon>
                </div>`);

            video.style.pointerEvents = 'none';

            const q = sel => this.el.querySelector(sel);
            const fullscreen = q('.fullscreen');
            const pip = q('.pip');
            const play = q('.play');
            const volume = q('.volume');

            // Fuldskærm (iOS har kun video-fuldskærm)
            if (this.card._canFs() || video.webkitEnterFullscreen) this.fsIcon = fullscreen;
            else fullscreen.hidden = true;

            // Billede-i-billede: som standard kun på computer (ikke på touch-enheder), og skjult hvis browserens PiP er slået fra
            const touch = !!window.matchMedia && matchMedia('(pointer: coarse)').matches;
            const pipOn = this.o.pip === 'always' || this.o.pip === 'own' || (this.o.pip === 'auto' && !touch);
            const ownOnly = this.o.pip === 'own';   // browserens knap er skjult; PiP låses kun op, mens kortets egen knap åbner det
            if (video.requestPictureInPicture && this.o.pip !== 'off' && pipOn) {
                video.addEventListener('enterpictureinpicture', () => {
                    pip.icon = 'mdi:rectangle';
                    this.player.background = true;
                });
                video.addEventListener('leavepictureinpicture', () => {
                    if (ownOnly) video.disablePictureInPicture = true;
                    pip.icon = 'mdi:picture-in-picture-bottom-right';
                    this.player.background = this.o.background;
                    this.player.play();
                });
            } else {
                pip.hidden = true;
            }

            q('.controls').addEventListener('click', ev => {
                const icon = ev.target.icon;
                if (icon === 'mdi:play') this.player.play();
                else if (icon === 'mdi:volume-mute') video.muted = false;
                else if (icon === 'mdi:volume-high') video.muted = true;
                else if (icon === 'mdi:fullscreen') this.enterFs();
                else if (icon === 'mdi:fullscreen-exit') document.exitFullscreen().catch(console.warn);
                else if (icon === 'mdi:camera') this._saveScreenshot();
                else if (icon === 'mdi:picture-in-picture-bottom-right') {
                    if (ownOnly) video.disablePictureInPicture = false;
                    video.requestPictureInPicture().catch(er => {
                        if (ownOnly) video.disablePictureInPicture = true;
                        console.warn(er);
                    });
                }
                else if (icon === 'mdi:rectangle') document.exitPictureInPicture().catch(console.warn);
            });

            video.addEventListener('play', () => {
                play.hidden = true;
            });
            video.addEventListener('pause', () => {
                play.hidden = false;
            });
            video.addEventListener('loadeddata', () => {
                volume.hidden = !this.player.hasAudio;
            });
            video.addEventListener('volumechange', () => {
                volume.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
            });
            volume.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
        }

        _saveScreenshot() {
            const video = this.player.video;
            const a = document.createElement('a');

            if (video.videoWidth && video.videoHeight) {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                a.href = canvas.toDataURL('image/jpeg');
                freeCv(canvas);
            } else if (video.poster && video.poster.startsWith('data:image/jpeg')) {
                a.href = video.poster;
            } else {
                return;
            }

            const ts = new Date().toISOString().substring(0, 19).replaceAll('-', '').replaceAll(':', '');
            a.download = `snapshot_${ts}.jpeg`;
            a.click();
        }

        /* ---------- PTZ ---------- */

        _buildPtz() {
            const ptz = this.cam.ptz;
            const icons = DIRS.map(d =>
                `<ha-icon class="${d}${ptz.data[d] ? '' : ' off'}" data-dir="${d}" icon="${DIR_ICONS[d]}"></ha-icon>`
            ).join('');

            this.ui.player.insertAdjacentHTML('beforeend',
                `<div class="ptz" style="--pn-ptz-opacity: ${ptz.opacity}"><div class="ring">${icons}</div></div>`);

            const [domain, service] = ptz.service.split('.', 2);
            this.el.querySelector('.ptz').addEventListener('click', ev => {
                const dir = ev.target.dataset && ev.target.dataset.dir;
                const hass = this.card._hass;
                if (!dir || !ptz.data[dir] || !hass) return;
                hass.callService(domain, service, ptz.data[dir]);
            });
        }

        /* ---------- Digital zoom og panorering (kun på store fliser) ---------- */

        _initZoom() {
            const area = this.ui.player;
            const zoomEl = this.ui.zoom;
            const st = {s: 1, x: 0, y: 0};
            const pts = new Map();
            let pinch = 0;

            const apply = () => {
                const r = area.getBoundingClientRect();
                const mx = (st.s - 1) * r.width / 2;
                const my = (st.s - 1) * r.height / 2;
                st.x = clamp(st.x, -mx, mx);
                st.y = clamp(st.y, -my, my);
                zoomEl.style.transform = st.s === 1 ? '' : `translate(${st.x}px, ${st.y}px) scale(${st.s})`;
                area.style.touchAction = st.s === 1 ? 'pan-y' : 'none';
            };
            this.resetZoom = () => {
                st.s = 1;
                st.x = 0;
                st.y = 0;
                apply();
            };

            // Zoom omkring punktet (cx, cy) i skærmkoordinater, så punktet bliver stående
            const zoomAt = (cx, cy, ns) => {
                const r = area.getBoundingClientRect();
                ns = clamp(ns, 1, 10);
                const px = cx - (r.left + r.width / 2);
                const py = cy - (r.top + r.height / 2);
                const k = ns / st.s;
                st.x = px - k * (px - st.x);
                st.y = py - k * (py - st.y);
                st.s = ns;
                apply();
            };

            const skip = ev => !this.big || (!!ev.target.closest && !!ev.target.closest('.ptz, .controls, .quality, .car-pause, .cp, .cp-btn'));

            area.addEventListener('wheel', ev => {
                if (skip(ev)) return;
                ev.preventDefault();
                zoomAt(ev.clientX, ev.clientY, st.s * (1 - ev.deltaY / 1000));
            }, {passive: false});

            // Dobbeltklik (computer) og dobbelttryk (touch) zoomer ind og ud. Kan slås fra med double_tap_zoom: false.
            let lastTap = {t: 0, x: 0, y: 0};
            let touchZoomAt = 0;
            let downAt = null;
            const toggleZoom = (x, y) => {
                zoomEl.style.transition = 'transform 200ms';
                setTimeout(() => {
                    zoomEl.style.transition = '';
                }, 220);
                zoomAt(x, y, st.s === 1 ? 2 : 1);
            };
            area.addEventListener('dblclick', ev => {
                if (skip(ev) || !this.o.doubleTap) return;
                if (Date.now() - touchZoomAt < 700) return;   // allerede håndteret som dobbelttryk
                zoomEl.style.transition = 'transform 200ms';
                setTimeout(() => {
                    zoomEl.style.transition = '';
                }, 220);
                zoomAt(ev.clientX, ev.clientY, st.s === 1 ? 2 : 1);
            });

            area.addEventListener('pointerdown', ev => {
                if (skip(ev)) return;
                pts.set(ev.pointerId, {x: ev.clientX, y: ev.clientY});
                downAt = pts.size === 1 ? {x: ev.clientX, y: ev.clientY} : null;
                try {
                    area.setPointerCapture(ev.pointerId);
                } catch (e) {
                    // ikke kritisk
                }
                if (pts.size === 2) {
                    const [a, b] = [...pts.values()];
                    pinch = Math.hypot(a.x - b.x, a.y - b.y);
                }
            });

            area.addEventListener('pointermove', ev => {
                const p = pts.get(ev.pointerId);
                if (!p) return;
                const dx = ev.clientX - p.x;
                const dy = ev.clientY - p.y;
                p.x = ev.clientX;
                p.y = ev.clientY;

                if (pts.size === 1) {
                    if (st.s > 1) {
                        st.x += dx;
                        st.y += dy;
                        apply();
                    }
                } else if (pts.size === 2) {
                    const [a, b] = [...pts.values()];
                    const d = Math.hypot(a.x - b.x, a.y - b.y);
                    if (pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, st.s * d / pinch);
                    pinch = d;
                }
            });

            const end = ev => {
                pts.delete(ev.pointerId);
                pinch = 0;
            };
            area.addEventListener('pointerup', ev => {
                // Dobbelttryk på touch: to korte tryk tæt på hinanden
                if (ev.pointerType === 'touch' && this.o.doubleTap && downAt && !skip(ev) && pts.size <= 1) {
                    const still = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) < 12;
                    const now = Date.now();
                    if (still) {
                        if (now - lastTap.t < 320 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 40) {
                            touchZoomAt = now;
                            lastTap = {t: 0, x: 0, y: 0};
                            toggleZoom(ev.clientX, ev.clientY);
                        } else {
                            lastTap = {t: now, x: ev.clientX, y: ev.clientY};
                        }
                    }
                }
                downAt = null;
                end(ev);
            });
            area.addEventListener('pointercancel', end);

            const ro = new ResizeObserver(() => apply());
            ro.observe(area);
            this.cleanups.push(() => ro.disconnect());
        }
    }

    class PanoptesCard extends HTMLElement {
        static getConfigElement() {
            return document.createElement('panoptes-card-editor');
        }

        static getStubConfig() {
            return {cameras: [{name: tr('camera'), streams: [{name: 'HD', url: ''}]}]};
        }

        constructor() {
            super();
            this._hass = null;
            this._config = null;
            this._tiles = [];
            this._focus = 0;
            this._multi = false;
            this._wall = null;
            this._ro = null;
            this._layoutKey = '';
            this._playIntro = true;
            this._introSeen = false;
            this._introKey = '';
        }

        /* ---------- Home Assistant-kontrakt ---------- */

        setConfig(config) {
            if (!config || typeof config !== 'object') throw new Error(tr('invalid_config'));
            this._config = config;
            this._o = this._options(config);
            this._cams = this._cameras(config);
            this._focus = 0;

            // Opstarten afspilles, når kortet indlæses, og når man ændrer den i editoren (ikke ved hver anden ændring)
            const key = `${this._o.intro}|${this._o.introColor}|${this._o.introSpeed}`;
            this._playIntro = !this._introSeen || key !== this._introKey;
            this._introSeen = true;
            this._introKey = key;

            this._render();
        }

        set hass(hass) {
            this._hass = hass;
            // Skifter sproget (HA's sprog kendes først nu), bygges kortet igen, så teksterne passer
            if (setLang(hass) && this._cams && this._tiles && this._tiles.length) { this._playIntro = false; this._render(); }
            this._tiles.forEach(t => {
                if (t.player) t.player.hass = hass;
                t.refreshControl();
            });
        }

        get hass() {
            return this._hass;
        }

        getCardSize() {
            return this._multi ? 6 : 5;
        }

        getGridOptions() {
            return {columns: 12, rows: 'auto', min_columns: 3};
        }

        connectedCallback() {
            if (this._tiles && this._tiles.length) {
                this._carStart();
                if (this.shadowRoot) this._dbgStart(this.shadowRoot);
            }
        }

        disconnectedCallback() {
            // Playerne lukker selv streamene efter få sekunder
            this._dbgStop();
            this._carStop();
            this._fsCleanup();
        }

        /* ---------- Opsætning ---------- */

        _options(c) {
            const ar = String(c.aspect_ratio || '16/9');
            const cols = parseInt(c.grid_columns, 10);
            return {
                muted: c.muted !== false,
                ui: c.ui !== false && c.ui !== 'browser' && c.ui !== 'none',
                uiMode: c.ui === false || c.ui === 'browser' ? 'browser' : c.ui === 'none' ? 'none' : 'own',
                zoom: c.digital_zoom !== false && c.digital_ptz !== false,
                doubleTap: c.double_tap_zoom !== false,
                pause: c.pause_offscreen !== false && c.intersection !== 0,
                threshold: typeof c.intersection === 'number' && c.intersection > 0 ? c.intersection : 0.5,
                background: !!c.background,
                showStatus: !!c.show_status,
                poster: c.poster || '',
                ar: /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(ar) ? ar : '16/9',
                camLabel: c.cam_label === true,
                camLabelStyle: CL_STYLES.includes(c.cam_label_style) ? c.cam_label_style : 'pill',
                camLabelText: c.cam_label_text === 'name' ? 'name' : 'number',
                camLabelOffset: Number.isFinite(parseFloat(c.cam_label_offset)) ? clamp(parseFloat(c.cam_label_offset), 0, 100) : 14,
                camLabelReadout: c.cam_label_readout === true,
                camLabelSide: Number.isFinite(parseFloat(c.cam_label_side)) && parseFloat(c.cam_label_side) !== 12 ? clamp(parseFloat(c.cam_label_side), 0, 100) : null,
                camLabelReadoutColor: c.cam_label_readout_color === 'label' ? 'label' : 'own',
                camLabelColor: CL_COLORS.includes(c.cam_label_color) ? c.cam_label_color : 'auto',
                camLabelTextCss: this._labelColor(c),
                camLabelPos: {
                    big: clPos(c, 'cam_label_pos'),
                    small: clPos(c, 'cam_label_pos_small'),
                    fs: clPos(c, 'cam_label_pos_fs'),
                },
                hidePip: c.ui === 'none' || ((c.ui !== false && c.ui !== 'browser') && (c.pip === 'off' || c.pip === 'own')),   // browserens egen PiP-knap skjules
                titlePos: ['top-left', 'top-center', 'top-right', 'bottom-center', 'hidden'].includes(c.title_position) ? c.title_position : 'top-center',
                titleOffset: Number.isFinite(parseFloat(c.title_offset)) ? clamp(parseFloat(c.title_offset), 0, 100) : 14,
                server: c.server || '',
                mode: c.mode || (c.mse === false ? 'webrtc' : c.webrtc === false ? 'mse' : ''),
                media: c.media || '',
                layout: ['auto', 'single', 'grid', 'focus'].includes(c.layout) ? c.layout : 'auto',
                strip: ['auto', 'right', 'bottom'].includes(c.strip) ? c.strip : 'auto',
                gridColumns: cols >= 1 && cols <= 4 ? cols : 0,
                gap: Number.isFinite(parseFloat(c.gap)) ? clamp(parseFloat(c.gap), 0, 40) : 8,
                autoQuality: c.auto_quality !== false,
                animations: c.animations !== false,
                intro: INTRO_VARIANTS.includes(c.intro) ? c.intro : 'focus',
                pip: ['auto', 'always', 'never', 'own', 'off'].includes(c.pip) ? c.pip : 'auto',
                radius: Number.isFinite(parseFloat(c.corner_radius)) ? clamp(parseFloat(c.corner_radius), 0, 32) : null,
                nav: c.camera_nav !== false,
                readout: Array.isArray(c.readout) ? c.readout.filter(k => READOUT_ITEMS.includes(k)) : READOUT_DEFAULT.slice(),
                switchFx: SWITCH_FX.includes(c.switch_effect) ? c.switch_effect : null,
                carousel: c.carousel === true,
                carInterval: clamp(parseInt(c.carousel_interval, 10) || 10, 3, 600),
                carBar: c.carousel_bar !== false,
                carPause: c.carousel_pause !== false,
                carFs: c.fullscreen_carousel !== false,
                fsPause: c.fullscreen_pause_others === true,
                fsNav: c.fullscreen_nav !== false,
                fsModes: Array.isArray(c.fullscreen_nav_modes) ? c.fullscreen_nav_modes.filter(k => FS_MODES.includes(k)) : FS_MODES_DEFAULT.slice(),
                panel: c.control_panel !== false,
                presetStyle: ['buttons', 'dropdown'].includes(c.preset_style) ? c.preset_style : 'auto',
                privacySmall: c.privacy_cover_small !== false,
                privacyQuality: PRIVACY_QUALITY.includes(c.privacy_cover_quality) ? c.privacy_cover_quality : 'normal',
                privacyCover: PRIVACY_COVERS.includes(c.privacy_cover) ? c.privacy_cover : 'black',
                navPos: c.nav_position === 'sides' ? 'sides' : 'bottom',
                introColor: this._accentColor(c),
                introSpeed: INTRO_SPEED[c.intro_speed] || 1,
                debug: c.debug === true,
                stillMax: STILL_SIZE[c.still_size] !== undefined ? STILL_SIZE[c.still_size] : STILL_SIZE.medium,
            };
        }

        /** Accentfarven. */
        _accentColor(c) {
            const key = c.accent_color;
            if (key === 'custom') {
                const v = String(c.accent_color_custom || '').trim();
                if (v && /^[a-zA-Z0-9#(),.%\s\/-]+$/.test(v) && window.CSS && CSS.supports('color', v)) return v;
                return INTRO_COLORS.primary;
            }
            return INTRO_COLORS[key] || INTRO_COLORS.primary;
        }

        /** Mærkets tekstfarve: null hvis stilen selv bestemmer. */
        _labelColor(c) {
            const k = c.cam_label_color;
            if (k === 'white') return '#fff';
            if (k === 'accent') return this._accentColor(c);
            if (k === 'custom') {
                const v = String(c.cam_label_color_custom || '').trim();
                if (v && /^[a-zA-Z0-9#(),.%\s\/-]+$/.test(v) && window.CSS && CSS.supports('color', v)) return v;
                return '#fff';
            }
            return null;
        }

        /** Kamerastyring: gyldige entity-id'er pr. funktion (eller null, hvis ingen er valgt). */
        _controlFrom(ctl) {
            if (!ctl || typeof ctl !== 'object') return null;
            const out = {};
            CONTROL_KEYS.forEach(k => {
                if (typeof ctl[k] === 'string' && ENTITY_RE.test(ctl[k])) out[k] = ctl[k];
            });
            return Object.keys(out).length ? out : null;
        }

        /** Omsætter ptz-opsætningen til det, en flise skal bruge (eller null). */
        _ptzFrom(ptz) {
            if (!ptz || ptz.enabled === false || typeof ptz.service !== 'string' || ptz.service.indexOf('.') < 1) return null;
            const data = {};
            DIRS.forEach(d => {
                if (ptz['data_' + d]) data[d] = ptz['data_' + d];
            });
            if (!Object.keys(data).length) return null;
            const op = parseFloat(ptz.opacity);
            return {service: ptz.service, data, opacity: op >= 0 && op <= 1 ? op : 0.4};
        }

        /**
         * Understøtter både det nye format (cameras:) og det gamle (streams: / url: / entity:
         * direkte på kortet). Et ptz: øverst på kortet gælder for det første kamera.
         */
        _cameras(config) {
            const list = Array.isArray(config.cameras) && config.cameras.length ? config.cameras : [config];
            return list.map((cam, i) => {
                let streams = cam.streams;
                if (!Array.isArray(streams)) {
                    streams = (cam.url || cam.entity) ? [{url: cam.url, entity: cam.entity}] : [];
                }
                streams = streams
                    .map(s => typeof s === 'string' ? {url: s} : s)
                    .filter(s => s && (s.url || s.entity));
                return {
                    name: cam.name || cam.title || '',
                    label: typeof cam.label === 'string' ? cam.label.trim().slice(0, 24) : '',
                    streams,
                    ptz: this._ptzFrom(cam.ptz || (i === 0 ? config.ptz : null)),
                    control: this._controlFrom(cam.control),
                };
            });
        }

        /* ---------- Opbygning ---------- */

        _teardown() {
            if (this._ro) {
                this._ro.disconnect();
                this._ro = null;
            }
            this._carStop();
            this._fsCleanup();
            this._dbgStop();
            this._tiles.forEach(t => t.destroy());
            this._tiles = [];
        }

        /* ---------- Debug (kun med debug: true i YAML) ---------- */

        _dbgStop() {
            if (this._dbgTID) {
                clearInterval(this._dbgTID);
                this._dbgTID = 0;
            }
        }

        _dbgStart(root) {
            this._dbgStop();
            const el = root.querySelector('ha-card');
            if (!el || !this._o.debug) return;
            root.querySelectorAll('.dbg').forEach(b => b.remove());   // ingen dubletter, når kortet sættes ind igen
            const box = document.createElement('div');
            box.className = 'dbg';
            el.appendChild(box);
            const KEY = 'panoptes-debug';
            // "Sidste måling" læses kun én gang pr. sideindlæsning (ellers viser den sidens egen forrige måling)
            if (DBG.prev === null) {
                DBG.prev = '';
                try {
                    const o = JSON.parse(localStorage.getItem(KEY) || 'null');
                    if (o && o.t) DBG.prev = `Sidste måling før start: ${new Date(o.t).toLocaleTimeString()} · oppetid ${o.up} min · heap ${o.heap} MB · ${o.txt}`;
                } catch (e) { /* ingen lager */ }
            }
            const prev = DBG.prev;
            let last = 0;
            const tick = () => {
                const mem = performance && performance.memory;
                const heap = mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1;
                if (heap >= 0 && !DBG.heap0) DBG.heap0 = heap;
                const up = Math.round((Date.now() - DBG.t0) / 60000);
                const q = sel => root.querySelectorAll(sel).length;
                const live = (this._tiles || []).filter(t => t.player && (t.player.ws || t.player.pc)).length;
                let cvMB = 0;
                root.querySelectorAll('canvas').forEach(c => { cvMB += c.width * c.height * 4; });
                cvMB = Math.round(cvMB / 1048576 * 10) / 10;
                const n = DBG.n;
                const pcv = Array.from(root.querySelectorAll('.cv-canvas')).reduce((m, c) => (c.width > (m ? m.width : 0) ? c : m), null);
                const priv = pcv ? ` · privatlivslærred ${pcv.width}x${pcv.height}` : '';
                const txt = `v${VERSION} · dpr ${window.devicePixelRatio || 1}${priv} · streams ${live}/${(this._tiles || []).length} · video ${q('video')} canvas ${q('canvas')} (${cvMB} MB) noder ${q('*')} · connect ${n.connect} stop ${n.stop} gen ${n.reconn} · still ${n.snap} skift ${n.swap} render ${n.render}`;
                box.textContent = `${prev ? prev + '\n' : ''}Oppetid ${up} min · heap ${heap >= 0 ? heap + ' MB (start ' + DBG.heap0 + ')' : 'ikke målbar'}\n${txt}`;
                if (Date.now() - last > 10000) {
                    last = Date.now();
                    try { localStorage.setItem(KEY, JSON.stringify({t: Date.now(), up, heap, txt})); } catch (e) { /* ingen lager */ }
                }
            };
            tick();
            this._dbgTID = setInterval(tick, 2000);
        }

        _render() {
            this._teardown();
            DBG.n.render++;

            const root = this.shadowRoot || this.attachShadow({mode: 'open'});
            const o = this._o;
            const multi = this._cams.length > 1 && o.layout !== 'single';
            this._multi = multi;
            if (!(this._sel >= 0 && this._sel < this._cams.length)) this._sel = 0;
            const nav = !multi && o.layout === 'single' && this._cams.length > 1 && o.nav;

            root.innerHTML = `
                <style>${CARD_CSS}</style>
                <ha-card class="card${o.camLabelReadout ? ' ro-st' : ''}${multi ? ' multi' : ''}${o.radius !== null ? ' has-radius' : ''}${o.privacySmall ? ' fx-small' : ''}"
                    data-cst="${o.camLabelStyle}"${o.camLabelTextCss ? ` data-clc="${o.camLabelColor}"` : ''} data-rol="${o.camLabelReadoutColor}" data-clb="${o.camLabelPos.big}" data-cls="${o.camLabelPos.small}" data-clf="${o.camLabelPos.fs}"
                    style="--pn-ar: ${o.ar}; --pn-title-offset: ${o.titleOffset}px; --pn-cl-off: ${o.camLabelOffset}px;${o.camLabelSide !== null ? ` --pn-cl-side: ${o.camLabelSide}px;` : ''}${o.camLabelTextCss ? ` --pn-clt: ${o.camLabelTextCss};` : ''} --pn-gap: ${o.gap}px; --pn-intro: ${o.introColor}${o.radius !== null ? `; --pn-radius: ${o.radius}px` : ''}">
                    <div class="wall"></div>
                    ${this._carActive() ? '<div class="car-bar"><i></i></div>' : ''}
                    ${this._fsNavHtml()}
                    ${nav ? `<div class="nav nav-${o.navPos}"><div class="nav-bar">
                        <button class="nav-btn prev" type="button" aria-label="${tr('tile.prev_cam')}"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
                        <div class="nav-dots">${this._cams.map((c, i) => `<button class="nav-dot" type="button" data-i="${i}" title="${String(c.name || tr('camera_n', i + 1)).replace(/[&<>"]/g, '')}"></button>`).join('')}</div>
                        <button class="nav-btn next" type="button" aria-label="${tr('tile.next_cam')}"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
                    </div></div>` : ''}
                </ha-card>`;
            this._wall = root.querySelector('.wall');
            this._fsOn = false;
            this._wireFs(root);
            if (nav) this._wireNav(root);

            const cams = multi ? this._cams : [this._cams[this._sel]];
            this._tiles = cams.map((cam, i) => {
                const t = new PanoptesTile(this, multi ? i : this._sel, cam);
                this._wall.appendChild(t.el);
                return t;
            });

            this._layoutKey = '';
            this._layout();
            this._tiles.forEach(t => t.start());

            if (multi && 'ResizeObserver' in window) {
                this._ro = new ResizeObserver(() => this._layout());
                this._ro.observe(this._wall);
            }
            this._carStart();
            this._dbgStart(root);
        }

        /* ---------- Karrusel (automatisk kameraskift) ---------- */

        /** Karrusellen kører, når den er slået til, og der er flere kameraer i et layout, der kan skifte. */
        _carActive() {
            const o = this._o;
            if (!o.carousel || this._cams.length < 2) return false;
            if (this._multi) return o.layout !== 'grid';
            return o.layout === 'single';
        }

        _camPrivate(i) {
            const cam = this._cams[i];
            const id = cam && cam.control && cam.control.privacy;
            const st = id && this._hass && this._hass.states[id];
            return !!st && st.state === 'on';
        }

        _carStart() {
            this._carStop();
            if (!this._carActive()) this._carPaused = false;
            if (!this._carActive() || !this.shadowRoot) return;
            const root = this.shadowRoot;
            const el = root.querySelector('ha-card');
            const bar = root.querySelector('.car-bar');
            if (!el) return;
            const car = this._car = {elapsed: 0, last: performance.now(), lastAct: 0, hover: false, visible: true, cleanups: []};
            const on = (target, type, fn, opts) => {
                target.addEventListener(type, fn, opts);
                car.cleanups.push(() => target.removeEventListener(type, fn, opts));
            };
            const act = () => {
                car.lastAct = performance.now();
            };
            ['pointerdown', 'wheel', 'keydown', 'focusin'].forEach(t => on(el, t, act, {passive: true}));
            on(el, 'pointerenter', ev => {
                if (ev.pointerType === 'mouse') car.hover = true;
            });
            on(el, 'pointerleave', ev => {
                if (ev.pointerType === 'mouse') {
                    car.hover = false;
                    act();
                }
            });
            if ('IntersectionObserver' in window) {
                const io = new IntersectionObserver(es => {
                    car.visible = es.some(e => e.isIntersecting);
                });
                io.observe(el);
                car.cleanups.push(() => io.disconnect());
            }

            const busy = () => {
                if (document.hidden || !car.visible) return true;
                if (car.hover && !(this._fsOn && this._o.carFs)) return true;
                if (performance.now() - car.lastAct < 6000) return true;
                return this._tiles.some(t => {
                    const zoomed = t.ui && t.ui.player && t.ui.player.style.touchAction === 'none';
                    const panel = t.ui && t.ui.cp && t.ui.cp.classList.contains('open');
                    return zoomed || panel || (t.el.classList.contains('fs') && !this._o.carFs);
                });
            };
            const setBar = f => {
                if (bar) bar.style.setProperty('--pn-car', String(f));
            };

            const id = setInterval(() => {
                const now = performance.now();
                const dt = Math.min(now - car.last, 1000);
                car.last = now;
                if (this._carPaused) return;   // bevidst pause: tælleren og linjen står stille
                if (busy()) {
                    car.elapsed = 0;
                    setBar(0);
                    return;
                }
                if (this._carNext() < 0) {   // alle andre kameraer har privatliv: intet at skifte til, linjen står på nul
                    car.elapsed = 0;
                    setBar(0);
                    return;
                }
                car.elapsed += dt;
                const total = this._o.carInterval * 1000;
                setBar(Math.min(1, car.elapsed / total));
                if (car.elapsed < total) return;
                car.elapsed = 0;
                const next = this._carNext();
                if (next >= 0) {
                    if (this._fsOn) this._fsGo(next, 1, true);
                    else if (this._multi) this._focusCamera(next, true);
                    else this._selectCamera(next, true);
                }
                setBar(0);
            }, 250);
            car.cleanups.push(() => clearInterval(id));
            this._carPauseSync();
        }

        _carStop() {
            if (this._car) {
                this._car.cleanups.forEach(fn => fn());
                this._car = null;
            }
        }

        _carReset() {
            if (this._car) this._car.elapsed = 0;
        }

        /** Pauseknappen: holder karrusellen, til man trykker igen (gemmes ikke ved genindlæsning). */
        _carTogglePause() {
            this._carPaused = !this._carPaused;
            this._carPauseSync();
        }

        _carPauseSync() {
            const root = this.shadowRoot;
            if (!root) return;
            const on = !!this._carPaused;
            root.querySelectorAll('.car-pause').forEach(b => {
                b.classList.toggle('on', on);
                b.setAttribute('aria-label', tr(on ? 'tile.carousel_resume' : 'tile.carousel_pause'));
                b.title = tr(on ? 'tile.carousel_resume' : 'tile.carousel_pause');
                const ic = b.querySelector('ha-icon');
                if (ic) ic.setAttribute('icon', on ? 'mdi:play' : 'mdi:pause');
            });
        }

        /** Næste kamera, der ikke har privatliv slået til (-1, hvis der ikke er nogen at skifte til). */
        _carNext() {
            const n = this._cams.length;
            const cur = this._fsOn ? this._fsIdx : this._multi ? this._focus : this._sel;
            for (let k = 1; k < n; k++) {
                const i = (cur + k) % n;
                if (!this._camPrivate(i)) return i;
            }
            return -1;
        }


        /* ---------- Fuldskærm og kameraskift i fuldskærm ---------- */

        _canFs() {
            const el = this.shadowRoot && this.shadowRoot.querySelector('ha-card');
            return !!(el && el.requestFullscreen);
        }

        /** Hele kortet går i fuldskærm, så pile, prikker og miniaturer følger med. Returnerer false, hvis det ikke kan. */
        _enterFs(idx) {
            const el = this.shadowRoot && this.shadowRoot.querySelector('ha-card');
            if (!el || !el.requestFullscreen) return false;
            this._fsIdx = idx;
            el.requestFullscreen().catch(console.warn);
            return true;
        }

        _fsNavHtml() {
            const o = this._o;
            const n = this._cams.length;
            if (!o.fsNav || n < 2) return '';
            const arrows = o.fsModes.includes('arrows');
            const thumbs = o.fsModes.includes('thumbs');
            if (!arrows && !thumbs) return '';
            const nm = (c, i) => String(c.name || tr('camera_n', i + 1)).replace(/[&<>"]/g, '');
            const bar = arrows ? `<div class="fs-bar">
                    <button class="fs-btn" type="button" data-fs="prev" aria-label="${tr('tile.prev_cam')}"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
                    <div class="fs-dots">${this._cams.map((c, i) => `<button class="fs-dot" type="button" data-i="${i}" title="${nm(c, i)}"></button>`).join('')}</div>
                    <button class="fs-btn" type="button" data-fs="next" aria-label="${tr('tile.next_cam')}"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
                </div>` : '';
            const th = thumbs ? `<div class="fs-thumbs">${this._cams.map((c, i) =>
                `<button class="fs-th" type="button" data-i="${i}" title="${nm(c, i)}"><ha-icon icon="mdi:cctv"></ha-icon><img alt="" hidden><span>${nm(c, i)}</span></button>`).join('')}</div>` : '';
            return `<div class="fsnav${arrows ? ' has-bar' : ''}${thumbs ? ' has-thumbs' : ''}">${th}${bar}</div>`;
        }

        _wireFs(root) {
            const el = root.querySelector('ha-card');
            this._fsEl = el;
            this._fsThumbs = this._fsThumbs || {};
            el.addEventListener('fullscreenchange', () => this._fsChange());
            const nav = root.querySelector('.fsnav');
            if (!nav) return;
            nav.addEventListener('click', ev => {
                const b = ev.target.closest && ev.target.closest('[data-fs], [data-i]');
                if (!b) return;
                ev.stopPropagation();
                if (b.dataset.fs) this._fsStep(b.dataset.fs === 'next' ? 1 : -1);
                else {
                    const i = parseInt(b.dataset.i, 10);
                    this._fsGo(i, i > this._fsIdx ? 1 : -1);
                }
            });
        }

        _fsChange() {
            const el = this._fsEl;
            let on = false;
            try {
                on = !!el && el.matches(':fullscreen');
            } catch (e) {
                // ikke understøttet
            }
            this._fsOn = on;
            if (el) el.classList.toggle('fsmode', on);
            if (on && !(this._fsIdx >= 0 && this._fsIdx < this._cams.length)) this._fsIdx = this._multi ? this._focus : this._sel;
            this._tiles.forEach(t => t.setFs(on && t.idx === this._fsIdx));
            this._fsHold();
            this._carReset();
            this._fsListen(on);
            this._fsMark();
        }

        /** Tastatur, swipe og opfriskning af miniaturer, så længe kortet er i fuldskærm. */
        _fsListen(on) {
            this._fsCleanup(true);
            if (!on || !this._o.fsNav || this._cams.length < 2) return;
            const modes = this._o.fsModes;
            const off = this._fsOff = [];
            const add = (target, type, fn, opts) => {
                target.addEventListener(type, fn, opts);
                off.push(() => target.removeEventListener(type, fn, opts));
            };
            if (modes.includes('keys')) {
                add(document, 'keydown', ev => {
                    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
                    const t = ev.composedPath && ev.composedPath()[0];
                    if (t && /^(SELECT|INPUT|TEXTAREA)$/.test(t.tagName)) return;
                    ev.preventDefault();
                    this._fsStep(ev.key === 'ArrowRight' ? 1 : -1);
                });
            }
            if (modes.includes('swipe')) {
                let sx = 0;
                let sy = 0;
                let pid = null;
                const skip = '.fsnav, .controls, .ptz, .cp, .cp-btn, .quality, .car-pause';
                add(this._fsEl, 'pointerdown', ev => {
                    if (ev.pointerType !== 'touch' || !ev.isPrimary) return;
                    if (ev.target.closest && ev.target.closest(skip)) return;
                    sx = ev.clientX;
                    sy = ev.clientY;
                    pid = ev.pointerId;
                });
                add(this._fsEl, 'pointerup', ev => {
                    if (ev.pointerId !== pid) return;
                    pid = null;
                    const t = this._tiles.find(x => x.idx === this._fsIdx);
                    if (t && t.ui.player.style.touchAction === 'none') return;
                    const dx = ev.clientX - sx;
                    const dy = ev.clientY - sy;
                    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) this._fsStep(dx < 0 ? 1 : -1);
                });
            }
            if (modes.includes('thumbs')) {
                this._fsShots();
                /* Opfriskning i små bidder: ét kamera ad gangen, så hvert kamera stadig opfriskes ca. hvert 4. sek.,
                   men hovedtråden ikke låses af alle kameraer på én gang (mærkbart ved 4K) */
                const n = Math.max(1, this._cams.length);
                let k = 0;
                const id = setInterval(() => this._fsShots(k++ % n), Math.max(500, Math.round(4000 / n)));
                off.push(() => clearInterval(id));
            }
        }

        _fsCleanup(keep) {
            if (this._fsOff) this._fsOff.forEach(fn => fn());
            this._fsOff = null;
            if (!keep) this._fsOn = false;
        }

        _fsStep(d) {
            this._fsGo(this._fsIdx + d, d);
        }

        /** Skifter kamera, mens kortet er i fuldskærm. */
        _fsGo(i, dir, auto) {
            const n = this._cams.length;
            if (!this._fsOn || n < 2) return;
            i = ((i % n) + n) % n;
            if (i === this._fsIdx) return;
            if (!auto) this._carReset();
            this._fsShots();

            if (!this._multi) {
                this._selectCamera(i, !!auto, dir);
                return;
            }

            const o = this._o;
            const fx = o.animations ? pickFx(o.switchFx || 'slide') : 'none';
            const old = this._tiles[this._fsIdx];
            const nw = this._tiles[i];
            const snap = fx !== 'none' && old ? old._snapshot() : null;
            let next = snap && STILL_FX.includes(fx) ? nw._snapshot() : null;
            // Stoppet kamera med privatliv: der er intet levende billede, så dækslet bruges som "nyt billede" (ellers bliver effekten til en blød overgang)
            if (snap && !next && STILL_FX.includes(fx) && this._camPrivate(i)) next = nw._coverStill(snap);
            this._fsIdx = i;
            if (o.layout !== 'grid') {
                this._focus = i;
                this._layout();
            }
            // Er det nye kamera stoppet (pause skjulte kameraer), er der intet levende billede at skifte til endnu:
            // det gamle billede holdes frosset, til den nye stream spiller, og så kører effekten (som i layout Enkelt).
            // Ikke hvis kameraet har privatliv slået til: det sender typisk intet billede, så der ville ikke komme noget at vente på,
            // og dækslet viser alligevel ikke videoen. Her kører effekten med det samme.
            const cold = !!(nw && nw.player && nw.player._hold) && !this._camPrivate(i);
            this._tiles.forEach(t => t.setFs(t.idx === i));
            this._fsHold();
            if (snap) {
                if (cold) nw.beginSwap(snap, fx, dir || 1);
                else nw.playTransition(snap, fx, dir || 1, next);
            }
            this._fsMark();
        }

        /** Valgfrit: kameraer, der ikke ses i fuldskærm, lukker deres forbindelse og åbner igen, når de skal vises. Ikke sammen med fuldskærmskarrusel. */
        _fsHold() {
            const on = this._fsOn && this._multi && this._o.fsPause && !(this._carActive() && this._o.carFs);
            this._tiles.forEach(t => {
                if (t.player) t.player.setHold(on && t.idx !== this._fsIdx);
            });
        }

        _fsMark() {
            const root = this.shadowRoot;
            if (!root) return;
            root.querySelectorAll('.fs-dot, .fs-th').forEach(b => {
                const on = this._fsOn && parseInt(b.dataset.i, 10) === this._fsIdx;
                b.classList.toggle('on', on);
                b.setAttribute('aria-current', on ? 'true' : 'false');
            });
            if (this._fsOn) {
                const cur = root.querySelector('.fs-th.on');
                if (cur && cur.scrollIntoView) cur.scrollIntoView({block: 'nearest', inline: 'nearest'});
            }
        }

        /** Miniaturer i fuldskærmens kamerabjælke: opdaterer kun kamera `only`, eller alle, hvis `only` udelades. Kameraer, der ikke kører lige nu, viser det seneste billede. */
        _fsShots(only) {
            const root = this.shadowRoot;
            if (!root || !root.querySelector('.fs-th')) return;
            this._cams.forEach((c, i) => {
                if (only !== undefined && i !== only) return;
                const t = this._multi ? this._tiles[i] : (i === this._sel ? this._tiles[0] : null);
                const v = t && t.player && t.player.video;
                if (v && v.videoWidth && v.readyState >= 2 && !this._camPrivate(i)) {
                    const cv = document.createElement('canvas');
                    try {
                        cv.width = 224;
                        cv.height = Math.max(1, Math.round(224 * v.videoHeight / v.videoWidth));
                        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
                        this._fsThumbs[i] = cv.toDataURL('image/jpeg', 0.6);
                    } catch (e) {
                        // billedet kan ikke aflæses
                    } finally {
                        freeCv(cv);
                    }
                }
                const b = root.querySelector(`.fs-th[data-i="${i}"]`);
                if (!b || !this._fsThumbs[i]) return;
                const img = b.querySelector('img');
                img.src = this._fsThumbs[i];
                img.hidden = false;
                b.querySelector('ha-icon').hidden = true;
            });
        }

        /* ---------- Kameraskift i layout Enkelt ---------- */

        _wireNav(root) {
            const step = d => this._selectCamera(this._sel + d, false, d);
            root.querySelector('.nav-btn.prev').addEventListener('click', () => step(-1));
            root.querySelector('.nav-btn.next').addEventListener('click', () => step(1));
            root.querySelectorAll('.nav-dot').forEach(b => b.addEventListener('click', () => {
                const i = parseInt(b.dataset.i, 10);
                this._selectCamera(i, false, i > this._sel ? 1 : -1);
            }));
            this._markNav();

            // Swipe på touch (ikke mens der er zoomet ind, så panorering ikke forstyrres)
            let sx = 0;
            let sy = 0;
            let id = null;
            this._wall.addEventListener('pointerdown', ev => {
                if (ev.pointerType !== 'touch' || !ev.isPrimary) return;
                sx = ev.clientX;
                sy = ev.clientY;
                id = ev.pointerId;
            });
            this._wall.addEventListener('pointerup', ev => {
                if (ev.pointerId !== id) return;
                id = null;
                if (this._fsOn) return;
                const area = this._tiles[0] && this._tiles[0].ui.player;
                if (!area || area.style.touchAction === 'none') return;
                const dx = ev.clientX - sx;
                const dy = ev.clientY - sy;
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) step(dx < 0 ? 1 : -1);
            });
        }

        _markNav() {
            if (!this.shadowRoot) return;
            this.shadowRoot.querySelectorAll('.nav-dot').forEach(b => {
                const on = parseInt(b.dataset.i, 10) === this._sel;
                b.classList.toggle('on', on);
                b.setAttribute('aria-current', on ? 'true' : 'false');
            });
        }

        _selectCamera(i, auto, dir) {
            const n = this._cams.length;
            i = ((i % n) + n) % n;
            if (i === this._sel || this._multi || !this._tiles.length) return;
            if (!auto) this._carReset();
            const old = this._tiles[0];
            const fx = pickFx(this._o.switchFx || 'soft');
            const snap = fx !== 'none' ? old._snapshot() : null;
            old.destroy();
            old.el.remove();
            this._sel = i;
            this._playIntro = false;
            const t = new PanoptesTile(this, i, this._cams[i]);
            this._tiles = [t];
            this._wall.appendChild(t.el);
            this._layout();
            if (this._fsOn) {
                this._fsIdx = i;
                t.setFs(true);
            }
            if (snap) t.beginSwap(snap, fx, dir || 1);
            t.start();
            this._markNav();
            this._fsMark();
        }

        /* ---------- Layout ---------- */

        _layout() {
            const wall = this._wall;
            if (!wall) return;
            const o = this._o;

            if (!this._multi) {
                wall.dataset.layout = 'single';
                this._tiles.forEach(t => t.setRole('single'));
                return;
            }

            const n = this._tiles.length;
            const minis = n - 1;
            const w = wall.clientWidth || this.clientWidth || 600;
            const layout = o.layout === 'grid' ? 'grid' : 'focus';
            const strip = o.strip === 'auto' ? (w >= 560 && minis >= 2 ? 'right' : 'bottom') : o.strip;
            const cols = layout === 'grid'
                ? Math.min(n, o.gridColumns || (w < 420 ? 1 : w < 760 ? 2 : w < 1100 ? 3 : 4))
                : Math.min(Math.max(minis, 3), 5);

            const key = `${layout}|${strip}|${cols}|${this._focus}`;
            if (key === this._layoutKey) return;
            this._layoutKey = key;

            wall.dataset.layout = layout;
            wall.dataset.strip = layout === 'focus' ? strip : '';
            wall.style.setProperty('--pn-cols', cols);
            wall.style.gridTemplateRows = layout === 'focus' && strip === 'right' ? `repeat(${minis}, minmax(0, 1fr))` : '';

            let k = 0;
            this._tiles.forEach((t, i) => {
                const s = t.el.style;
                s.gridRow = '';
                s.gridColumn = '';

                if (layout === 'grid') {
                    t.setRole('grid');
                } else if (i === this._focus) {
                    t.setRole('main');
                    if (strip === 'right') {
                        s.gridColumn = '1';
                        s.gridRow = `1 / span ${minis}`;
                    } else {
                        s.gridColumn = '1 / -1';
                        s.gridRow = '1';
                    }
                } else {
                    t.setRole('mini');
                    k++;
                    if (strip === 'right') {
                        s.gridColumn = '2';
                        s.gridRow = String(k);
                    }
                }
            });
        }

        /** Gør et kamera til hovedkamera. Fliserne glider på plads, hvis animationer er slået til. */
        _focusCamera(idx, auto) {
            if (!this._multi || this._o.layout === 'grid' || idx === this._focus) return;
            if (!auto) this._carReset();

            const tiles = this._tiles;
            const fx = this._o.animations && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)
                ? pickFx(this._o.switchFx || 'slide') : 'none';
            const glide = fx === 'slide';
            const first = glide ? tiles.map(t => t.el.getBoundingClientRect()) : null;
            const snap = fx !== 'none' && !glide ? tiles[this._focus]._snapshot() : null;
            // Billedet af det nye hovedkamera tages før rollen skifter, for så nulstilles videoen (SD til HD)
            const next = snap && STILL_FX.includes(fx) ? tiles[idx]._snapshot() : null;

            this._focus = idx;
            this._layout();
            if (snap) tiles[idx].playTransition(snap, fx, 1, next);
            if (!first) return;

            tiles[idx].el.style.zIndex = 2;
            setTimeout(() => {
                tiles[idx].el.style.zIndex = '';
            }, 500);

            tiles.forEach((t, i) => {
                const a = first[i];
                const b = t.el.getBoundingClientRect();
                if (!a.width || !b.width) return;
                const dx = a.left - b.left;
                const dy = a.top - b.top;
                const sx = a.width / b.width;
                const sy = a.height / b.height;
                if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
                t.el.animate([
                    {transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`},
                    {transformOrigin: 'top left', transform: 'none'},
                ], {duration: 450, easing: 'cubic-bezier(0.22, 0.8, 0.2, 1)'});
            });
        }
    }

    /* ======================================================================
     * 3. EDITOR
     * Faner med ikoner. Hver fane er en gruppe. Nye funktioner tilføjes som felter
     * i en eksisterende gruppe (ét sted i skemaet) eller som en ny fane (TABS).
     * Bygget med HAs egne ha-form-felter.
     * ==================================================================== */

    /* ---------- Sprog ----------
     * Tekster til editor og kort står i STRINGS (en og da). Sproget følger Home Assistants sprog; mangler en tekst,
     * bruges engelsk. Nyt sprog: kopiér hele en-blokken, giv den sprogkoden (fx de) og oversæt værdierne.
     * Pladsholdere skrives {0}, {1} osv. */
    const STRINGS = {
    en: {
        // label
        'label.name': 'Name',
        'label.url': 'Stream (go2rtc name or URL)',
        'label.mode': 'Display method',
        'help.mode': 'How the stream is fetched. Automatic tries WebRTC first, then MSE, HLS and MJPEG. Only change this if a camera will not play. Can also be set per stream in YAML.',
        'label.still_size': 'Picture size for switch effects',
        'help.still_size': 'Effects use a still frame. Smaller is lighter on weak devices.',
        'label.layout': 'Layout',
        'label.strip': 'Thumbnails (strip)',
        'label.grid_columns': 'Grid columns',
        'label.gap': 'Gap between cameras (px)',
        'label.switch_effect': 'Effect when switching camera',
        'label.camera_nav': 'Arrows and dots for switching camera',
        'label.carousel': 'Carousel (switches camera automatically)',
        'label.carousel_interval': 'Time between switches',
        'label.carousel_bar': 'Show progress line to the next switch',
        'label.carousel_pause': 'Pause button for the carousel',
        'label.fullscreen_carousel': 'Carousel continues in fullscreen',
        'label.fullscreen_nav': 'Switch camera in fullscreen',
        'label.fullscreen_nav_modes': 'How to switch in fullscreen',
        'label.nav_position': 'Position of camera switching',
        'label.corner_radius': 'Corner radius (px)',
        'label.readout': 'Technical readout',
        'label.auto_quality': 'HD only on the large camera',
        'label.animations': 'Smooth switching between cameras',
        'label.intro': 'Startup animation',
        'label.accent_color': 'Accent colour',
        'label.accent_color_custom': 'Custom colour',
        'label.cam_label': 'CAM label on the cameras',
        'label.cam_label_style': 'Label style',
        'label.cam_label_text': 'Label shows',
        'label.cam_label_offset': 'Label distance from top/bottom (px)',
        'label.cam_label_side': 'Label distance from the side (px)',
        'label.cam_label_color': 'Label text colour',
        'label.cam_label_color_custom': 'Custom text colour',
        'label.cam_label_readout': 'Readout in the label style',
        'label.cam_label_readout_color': 'Readout colour',
        'label.cam_label_pos': 'Label position: the large camera',
        'label.cam_label_pos_small': 'Label position: small tiles',
        'label.cam_label_pos_fs': 'Label position: fullscreen',
        'label.label': 'CAM label (empty = automatic, e.g. CAM 01)',
        'label.intro_speed': 'Speed',
        'label.title_position': 'Title position',
        'label.title_offset': 'Title distance from the edge (px)',
        'label.aspect_ratio': 'Aspect ratio (e.g. 16/9)',
        'label.muted': 'Muted by default',
        'label.ui': 'Buttons on the picture',
        'help.ui': 'Own buttons: fullscreen, screenshot, picture-in-picture, play and sound. The same on every device. Browser: the browser\'s own player controls, only on the large camera (small tiles never get them). None: a clean picture, and the browser\'s picture-in-picture button is hidden too.',
        'label.pip': 'Picture-in-picture button',
        'label.digital_zoom': 'Digital zoom and panning',
        'label.double_tap_zoom': 'Double tap and double click zoom',
        'label.pause_offscreen': 'Pause stream when out of view',
        'label.fullscreen_pause_others': 'Pause hidden cameras in fullscreen',
        'label.background': 'Never stop streams',
        'label.show_status': 'Show connection type (RTC/MSE)',
        'help.show_status': 'Shows how the camera is connected (for example RTC or MSE) next to its name. Handy when troubleshooting.',
        'label.server': 'go2rtc address (optional)',
        'label.poster': 'Poster (go2rtc stream or image URL)',
        'label.enabled': 'Enable PTZ',
        'label.privacy': 'Privacy switch (switch)',
        'label.preset': 'Preset selector (select)',
        'label.patrol': 'Patrol switch (switch)',
        'label.patrol_mode': 'Patrol direction (select)',
        'label.light': 'Floodlight (light)',
        'label.control_panel': 'Control panel (button in the top right)',
        'label.preset_style': 'How presets are shown',
        'label.privacy_cover': 'Cover when privacy is on',
        'label.privacy_cover_small': 'Animation on small cameras too',
        'label.privacy_cover_quality': 'Sharpness of the animation',
        'label.left': 'Left',
        'label.right': 'Right',
        'label.up': 'Up',
        'label.down': 'Down',
        // help
        'help.accent_color': 'Used everywhere in the card: startup, colour effects when switching camera, active buttons, highlights and the number in the CAM label. Default follows the Home Assistant primary colour.',
        'help.cam_label': 'A small label such as CAM 01, based on the camera\'s position in the list. You can write your own text per camera under Cameras. Off by default.',
        'help.cam_label_style': 'Pill is the dark rounded background. Filled tab uses the accent colour. Line and Bar are clean and minimal. Outline is a thin frame, Corners are small corner brackets, Glass is translucent and blurred, and Dot is a small accent dot before the text. Text only has no background. Default is Pill.',
        'help.cam_label_text': 'Choose the camera name if the label should replace the title. You can then hide the title under Title position. A custom text per camera (under Cameras) always wins.',
        'help.cam_label_offset': 'Distance from the edge at the top and at the bottom centre, like the title distance. Default is 14 px.',
        'help.cam_label_side': 'Distance from the left and right edge when the label sits in a corner. Default is 12 px.',
        'help.cam_label_color': 'Follows the style means the style chooses itself (e.g. dark text on the filled tab). Choose White, the accent colour or a custom colour to override. With the accent colour or a custom colour the filled tab gets a dark background.',
        'help.cam_label_readout_color': 'Own style uses the style\'s own colours (e.g. an accent tab with dark text). Like the label uses the label\'s text colour and background. It only matters if you have chosen a text colour for the label.',
        'help.cam_label_readout': 'The technical readout at the bottom (connection, resolution, time and so on) gets the same style and colour as the label.',
        'help.cam_label_pos': 'At the top the label sits next to the title. At the bottom it sits above the technical readout. Choose Hidden to leave it out here. Default is top left.',
        'help.cam_label_pos_small': 'Applies to the thumbnails in Focus + strip and the tiles in the grid. Space is tight there, so Hidden can be a good idea.',
        'help.cam_label_pos_fs': 'Applies to the camera while the card is in fullscreen.',
        'help.url': 'E.g. hoveddor_hd',
        'help.layout': 'Automatic gives focus + strip with several cameras and single with one camera',
        'help.auto_quality': 'Thumbnails and the grid use the last stream (SD). The large camera and fullscreen use the first (HD).',
        'help.intro': 'Plays when the card loads. The picture is shown only once the stream is running.',
        'help.carousel_pause': 'A small button under the quality button that holds the carousel until you press it again',
        'help.carousel': 'Switches the camera shown. Pauses when you use the card, when privacy is on (the camera is skipped), and when the tab is hidden or the card is out of view.',
        'help.switch_effect': 'The old picture is held frozen and replaced by the new one. Slide means in Single that the picture is pushed, and in Focus + strip that the tiles glide. The speed follows the startup speed. Switching between HD and SD always uses the soft transition. The colour effects follow the accent colour from Look. Random picks a new effect at every switch. Default is Soft in Single and Slide in Focus.',
        'help.fullscreen_nav': 'Applies to all layouts. When off, fullscreen shows only the camera you opened.',
        'help.fullscreen_nav_modes': 'Arrows and dots sit at the bottom centre. Thumbnails are small pictures of the cameras along the edge. Swipe is for touch, and arrow keys are for computers.',
        'help.fullscreen_carousel': 'The carousel also switches camera while the card is in fullscreen.',
        'help.camera_nav': 'The arrows show on hover on computers and faintly on touch. On touch you can also swipe.',
        'help.corner_radius': 'Default follows Home Assistant\'s own card radius (typically 12 px)',
        'help.readout': 'Shown at the bottom of the large camera. Fps and bitrate are measured with WebRTC (bitrate with MSE too). Choose none to hide the readout.',
        'help.pip': 'Default is computers only. Never hides only the card\'s own button. Own button only hides the browser\'s own button (e.g. the small Firefox PiP button on the right edge) and keeps the card\'s. Off turns picture-in-picture off on the video completely.',
        'help.pause_offscreen': 'The stream stops when the card is scrolled out of view or the tab is hidden. Turned off, it keeps running out of view but still stops in a hidden tab.',
        'help.pause_offscreen_off_bg': 'Overridden by "Never stop streams" below.',
        'help.fullscreen_pause_others_off_bg': 'Overridden by "Never stop streams" below.',
        'help.background': 'The stream never stops, not even when the card is out of view, the tab is hidden or the camera is hidden in fullscreen. Uses more network and power. Overrides the two pause settings above. Picture-in-picture turns this on by itself while it is open.',
        'help.fullscreen_pause_others': 'Saves network and processing power, e.g. on a tablet that stays in fullscreen. The cameras you cannot see disconnect and reconnect when they are needed, so switching camera can take a moment longer, and the thumbnails in the bar stay still.',
        'help.fullscreen_pause_others_off': 'Not available while the carousel switches camera in fullscreen (all cameras would reconnect every time). Turn off "Carousel continues in fullscreen" to use it.',
        'help.server': 'Only if the stream is on a different go2rtc than the integration\'s',
        'help.poster': 'Shown while the stream is loading (optional)',
        'help.privacy': 'E.g. switch.kamera_hoveddor_privacy. Leave empty to not use it.',
        'help.preset': 'E.g. select.kamera_hoveddor_move_to_preset. Leave empty to not show presets.',
        'help.patrol': 'E.g. switch.kamera_hoveddor_preset_patrol_mode',
        'help.patrol_mode': 'E.g. select.kamera_hoveddor_patrol_mode (Horizontal/Vertical)',
        'help.light': 'E.g. light.kamera_hoveddor_floodlight_timed',
        'help.control_panel': 'The panel is shown only on the large camera and only with entities chosen under the camera.',
        'help.preset_style': 'Automatic shows buttons for up to six presets and a dropdown after that.',
        'help.privacy_cover_quality': 'Only for the animated covers. Higher is sharper on sharp screens but uses more memory while privacy is on.',
        'help.privacy_cover_small': 'Thumbnails and grid tiles animate too (a little slower). Turn off to animate only the large camera.',
        'help.privacy_cover': 'Shown over the picture while privacy is on. The animations use the accent colour and by default also run on small cameras (see the next setting).',
        'help.left': 'Button entity, e.g. button.kamera_hoveddor_move_left',
        // o
        'o.still_size.medium': 'Medium (1280 px, recommended)',
        'o.still_size.small': 'Small (640 px, lightest)',
        'o.still_size.full': 'Full video resolution',
        'o.ui.own': 'Own buttons',
        'o.ui.browser': 'Browser\'s own controls',
        'o.ui.none': 'None (clean picture)',
        'o.mode.auto': 'Automatic',
        'o.mode.webrtc': 'WebRTC',
        'o.mode.mse': 'MSE',
        'o.mode.hls': 'HLS',
        'o.mode.mjpeg': 'MJPEG',
        'o.layout.auto': 'Automatic',
        'o.layout.focus': 'Focus + strip',
        'o.layout.grid': 'Grid',
        'o.layout.single': 'Single (one camera at a time)',
        'o.switch_effect.soft': 'Soft transition',
        'o.switch_effect.zoom': 'Zoom',
        'o.switch_effect.flip': 'Flip',
        'o.switch_effect.pixel': 'Pixel',
        'o.switch_effect.cube': 'Cube (3D)',
        'o.switch_effect.push': 'Push over',
        'o.switch_effect.spin': 'Spin and zoom',
        'o.switch_effect.roll': 'Roll',
        'o.switch_effect.blur': 'Blur',
        'o.switch_effect.glitch': 'Glitch',
        'o.switch_effect.mosaic': 'Mosaic',
        'o.switch_effect.noise': 'Noise',
        'o.switch_effect.wash': 'Colour wipe (colour)',
        'o.switch_effect.tint': 'Colour filter (colour)',
        'o.switch_effect.ripple': 'Ripple (colour)',
        'o.switch_effect.random': 'Random',
        'o.switch_effect.none': 'No effect',
        'o.fullscreen_nav_modes.arrows': 'Arrows and dots',
        'o.fullscreen_nav_modes.thumbs': 'Thumbnails along the edge',
        'o.fullscreen_nav_modes.swipe': 'Swipe (touch)',
        'o.fullscreen_nav_modes.keys': 'Arrow keys (computer)',
        'o.nav_position.bottom': 'Bottom (pill with dots)',
        'o.nav_position.sides': 'At the sides',
        'o.carousel_interval.5': '5 seconds',
        'o.carousel_interval.10': '10 seconds',
        'o.carousel_interval.15': '15 seconds',
        'o.carousel_interval.30': '30 seconds',
        'o.carousel_interval.60': '1 minute',
        'o.strip.auto': 'Automatic',
        'o.strip.right': 'To the right',
        'o.strip.bottom': 'At the bottom',
        'o.grid_columns.auto': 'Automatic',
        'o.intro.focus': 'Focus in',
        'o.intro.boot': 'Boot text',
        'o.intro.frame': 'Frame drawing',
        'o.intro.scan': 'Light streak',
        'o.intro.iris': 'Circle',
        'o.intro.tv': 'TV switch-on',
        'o.intro.blinds': 'Blinds',
        'o.intro.none': 'None',
        'o.accent_color.ice': 'Ice blue',
        'o.accent_color.white': 'White',
        'o.accent_color.green': 'Green',
        'o.accent_color.amber': 'Amber',
        'o.accent_color.red': 'Red',
        'o.accent_color.violet': 'Violet',
        'o.accent_color.primary': 'Follow HA\'s primary colour',
        'o.accent_color.custom': 'Custom colour',
        'o.intro_speed.fast': 'Fast',
        'o.intro_speed.normal': 'Normal',
        'o.intro_speed.slow': 'Slow',
        'o.cam_label_pos.top-left': 'Top left',
        'o.cam_label_pos.top-center': 'Top centre',
        'o.cam_label_pos.top-right': 'Top right',
        'o.cam_label_pos.bottom-left': 'Bottom left',
        'o.cam_label_pos.bottom-center': 'Bottom centre',
        'o.cam_label_pos.bottom-right': 'Bottom right',
        'o.cam_label_pos.hidden': 'Hidden',
        'o.cam_label_style.pill': 'Pill',
        'o.cam_label_style.tab': 'Filled tab',
        'o.cam_label_style.line': 'Line',
        'o.cam_label_style.bar': 'Bar',
        'o.cam_label_style.text': 'Text only',
        'o.cam_label_style.outline': 'Outline',
        'o.cam_label_style.corners': 'Corners',
        'o.cam_label_style.glass': 'Glass',
        'o.cam_label_style.dot': 'Dot',
        'o.cam_label_color.auto': 'Follows the style',
        'o.cam_label_color.white': 'White',
        'o.cam_label_color.accent': 'The accent colour',
        'o.cam_label_color.custom': 'Custom colour',
        'o.cam_label_text.number': 'CAM number (or own text)',
        'o.cam_label_text.name': 'Camera name',
        'o.cam_label_readout_color.own': 'Own style',
        'o.cam_label_readout_color.label': 'Like the label',
        'o.title_position.top-left': 'Top left',
        'o.title_position.top-center': 'Top centre',
        'o.title_position.top-right': 'Top right',
        'o.title_position.bottom-center': 'Bottom centre',
        'o.title_position.hidden': 'Hidden',
        'o.readout.connection': 'Connection (RTC/MSE)',
        'o.readout.resolution': 'Resolution',
        'o.readout.fps': 'Frames per second',
        'o.readout.bitrate': 'Bitrate',
        'o.readout.clock': 'Clock',
        'o.preset_style.auto': 'Automatic',
        'o.preset_style.buttons': 'Buttons',
        'o.preset_style.dropdown': 'Dropdown',
        'o.privacy_cover.black': 'Black with lock',
        'o.privacy_cover.blur': 'Blur',
        'o.privacy_cover.network': 'Network',
        'o.privacy_cover.stream': 'Data stream',
        'o.privacy_cover.radar': 'Radar',
        'o.privacy_cover.cams': 'Camera net',
        'o.privacy_cover.clock': 'Clock',
        'o.privacy_cover.none': 'None (only the switch)',
        'o.privacy_cover_quality.low': 'Save memory',
        'o.privacy_cover_quality.normal': 'Normal',
        'o.privacy_cover_quality.high': 'Sharp (follows the screen)',
        'o.pip.auto': 'Computers only',
        'o.pip.always': 'Always',
        'o.pip.never': 'Never',
        'o.pip.own': 'Card\'s own button only (hides the browser\'s)',
        'o.pip.off': 'Off (also hides the card\'s button)',
        'o.switch_effect.slide_single': 'Slide (the picture is pushed)',
        'o.switch_effect.slide_grid': 'Slide (the tiles glide into place)',
        // tile
        'tile.cant_connect': 'Can\'t connect',
        'tile.conn_failed': 'Could not connect. Is the WebRTC Camera integration installed, and does the stream exist?',
        'tile.control_panel': 'Control panel',
        'tile.carousel_pause': 'Pause carousel',
        'tile.carousel_resume': 'Resume carousel',
        // camera
        'camera': 'Camera',
        // camera_n
        'camera_n': 'Camera {0}',
        // tile
        'tile.no_stream': 'No stream selected. Open the card editor and add a stream.',
        'tile.privacy_on': 'Privacy is on',
        'tile.cp.privacy': 'Privacy',
        'tile.cp.position': 'Position',
        'tile.cp.patrol': 'Patrol',
        'tile.cp.patrol_mode': 'Patrol direction',
        'tile.cp.light': 'Floodlight',
        'tile.cp.none': 'No controls found',
        'tile.error': 'Error',
        // invalid_config
        'invalid_config': 'Invalid configuration',
        // tile
        'tile.prev_cam': 'Previous camera',
        'tile.next_cam': 'Next camera',
        'tile.boot_connecting': 'CONNECTING {0} ...',
        // ed
        'ed.add_camera': '+ Add camera',
        'ed.layout_note': 'Strip, grid and gap are shown when the card has more than one camera.',
        'ed.panel_note': 'Which entities are shown in the panel is chosen per camera under Cameras, in the Camera controls section.',
        'ed.streams': 'Streams',
        'ed.add_stream': '+ Add stream',
        'ed.ptz_head': 'PTZ (camera movement)',
        'ed.ptz_note': 'PTZ uses a different service than button.press. Edit it in YAML.',
        'ed.ctl_head': 'Camera controls (privacy, presets, patrol, light)',
        'ed.ctl_note': 'Choose one entity and the editor suggests the others from the name. Empty fields are not shown in the panel.',
        'ed.move_up_title': 'Move up',
        'ed.move_up': '↑ Up',
        'ed.move_down_title': 'Move down',
        'ed.move_down': '↓ Down',
        'ed.remove_camera': 'Remove camera',
        'ed.remove_stream': 'Remove stream',
        'ed.controls_badge': 'Camera controls',
        'ed.tab_cams_n': 'Cameras ({0})',
        // tab
        'tab.cams': 'Cameras',
        'tab.layout': 'Layout',
        'tab.intro': 'Startup',
        'tab.look': 'Look',
        'tab.panel': 'Control',
        'tab.controls': 'Buttons',
        'tab.adv': 'Advanced',
    },
    da: {
        // label
        'label.name': 'Navn',
        'label.url': 'Stream (go2rtc-navn eller URL)',
        'label.mode': 'Visningsmetode',
        'help.mode': 'Hvordan streamen hentes. Automatisk prøver WebRTC først, så MSE, HLS og MJPEG. Skift kun, hvis et kamera ikke vil afspille. Kan også sættes pr. stream i YAML.',
        'label.still_size': 'Billedstørrelse til skifteeffekter',
        'help.still_size': 'Effekterne bruger et stillbillede. Mindre er lettere for svage enheder.',
        'label.layout': 'Layout',
        'label.strip': 'Miniaturer (strip)',
        'label.grid_columns': 'Kolonner i gitter',
        'label.gap': 'Mellemrum mellem kameraer (px)',
        'label.switch_effect': 'Effekt ved kameraskift',
        'label.camera_nav': 'Pile og prikker til kameraskift',
        'label.carousel': 'Karrusel (skifter kamera automatisk)',
        'label.carousel_interval': 'Tid mellem skift',
        'label.carousel_bar': 'Vis statuslinje til næste skift',
        'label.carousel_pause': 'Pauseknap til karrusel',
        'label.fullscreen_carousel': 'Karrusel fortsætter i fuldskærm',
        'label.fullscreen_nav': 'Skift kamera i fuldskærm',
        'label.fullscreen_nav_modes': 'Sådan skifter man i fuldskærm',
        'label.nav_position': 'Placering af kameraskift',
        'label.corner_radius': 'Hjørneradius (px)',
        'label.readout': 'Teknisk udlæsning',
        'label.auto_quality': 'HD kun på det store kamera',
        'label.animations': 'Glidende skift mellem kameraer',
        'label.intro': 'Opstart-animation',
        'label.accent_color': 'Accentfarve',
        'label.accent_color_custom': 'Egen farve',
        'label.cam_label': 'CAM-mærke på kameraerne',
        'label.cam_label_style': 'Mærkets stil',
        'label.cam_label_text': 'Mærket viser',
        'label.cam_label_offset': 'Mærkets afstand fra top/bund (px)',
        'label.cam_label_side': 'Mærkets afstand fra siden (px)',
        'label.cam_label_color': 'Mærkets tekstfarve',
        'label.cam_label_color_custom': 'Egen tekstfarve',
        'label.cam_label_readout': 'Udlæsningen i mærkets stil',
        'label.cam_label_readout_color': 'Udlæsningens farve',
        'label.cam_label_pos': 'Mærkets placering: det store kamera',
        'label.cam_label_pos_small': 'Mærkets placering: små fliser',
        'label.cam_label_pos_fs': 'Mærkets placering: fuldskærm',
        'label.label': 'CAM-mærke (tom = automatisk, fx CAM 01)',
        'label.intro_speed': 'Hastighed',
        'label.title_position': 'Titlens placering',
        'label.title_offset': 'Titlens afstand fra kanten (px)',
        'label.aspect_ratio': 'Billedformat (fx 16/9)',
        'label.muted': 'Lyd slået fra som standard',
        'label.ui': 'Knapper på billedet',
        'help.ui': 'Egne knapper: fuldskærm, screenshot, billede-i-billede, play og lyd. Ens på alle enheder. Browser: browserens egne afspillerkontroller, kun på det store kamera (små fliser får dem aldrig). Ingen: rent billede, og browserens billede-i-billede-knap skjules også.',
        'label.pip': 'Billede-i-billede-knap',
        'label.digital_zoom': 'Digital zoom og panorering',
        'label.double_tap_zoom': 'Dobbelttryk og dobbeltklik zoomer',
        'label.pause_offscreen': 'Pause stream uden for syne',
        'label.fullscreen_pause_others': 'Pause skjulte kameraer i fuldskærm',
        'label.background': 'Stop aldrig streams',
        'label.show_status': 'Vis forbindelsestype (RTC/MSE)',
        'help.show_status': 'Viser, hvordan kameraet er forbundet (f.eks. RTC eller MSE), ved siden af navnet. Praktisk ved fejlsøgning.',
        'label.server': 'go2rtc-adresse (valgfri)',
        'label.poster': 'Poster (go2rtc-stream eller billed-URL)',
        'label.enabled': 'Aktivér PTZ',
        'label.privacy': 'Privatliv-afbryder (switch)',
        'label.preset': 'Preset-vælger (select)',
        'label.patrol': 'Patrulje-afbryder (switch)',
        'label.patrol_mode': 'Patruljeretning (select)',
        'label.light': 'Projektørlys (light)',
        'label.control_panel': 'Kontrolpanel (knap øverst til højre)',
        'label.preset_style': 'Visning af presets',
        'label.privacy_cover': 'Dækning ved privatliv',
        'label.privacy_cover_small': 'Animation også på små kameraer',
        'label.privacy_cover_quality': 'Animationens skarphed',
        'label.left': 'Venstre',
        'label.right': 'Højre',
        'label.up': 'Op',
        'label.down': 'Ned',
        // help
        'help.accent_color': 'Bruges overalt i kortet: opstart, farve-effekter ved kameraskift, aktive knapper, markeringer og tallet i CAM-mærket. Standard følger Home Assistants primærfarve.',
        'help.cam_label': 'Lille mærke som CAM 01 ud fra kameraets plads i listen. Du kan skrive en egen tekst pr. kamera under Kameraer. Standard er slået fra.',
        'help.cam_label_style': 'Pille er den mørke afrundede baggrund. Fyldt fane bruger accentfarven. Linje og Streg er stilrene. Kontur er en tynd ramme, Hjørner er små hjørnebeslag, Glas er halvgennemsigtigt og sløret, og Prik er en lille accentprik foran teksten. Kun tekst har ingen baggrund. Standard er Pille.',
        'help.cam_label_text': 'Vælg kameraets navn, hvis mærket skal erstatte titlen. Så kan du skjule titlen under Titlens placering. En egen tekst pr. kamera (under Kameraer) vinder altid.',
        'help.cam_label_offset': 'Afstand fra kanten øverst og nederst i midten, som titlens afstand. Standard er 14 px.',
        'help.cam_label_side': 'Afstand fra venstre og højre kant, når mærket står i et hjørne. Standard er 12 px.',
        'help.cam_label_color': 'Følger stilen betyder, at stilen selv vælger (fx mørk tekst på den fyldte fane). Vælg Hvid, accentfarven eller en egen farve for at overstyre. Med accentfarve eller egen farve får den fyldte fane en mørk baggrund.',
        'help.cam_label_readout_color': 'Egen stil bruger stilens egne farver (fx accentfane med mørk tekst). Som mærket bruger mærkets tekstfarve og baggrund. Det har kun betydning, hvis du har valgt en tekstfarve til mærket.',
        'help.cam_label_readout': 'Den tekniske udlæsning nederst (forbindelse, opløsning, tid m.m.) får samme stil og farve som mærket.',
        'help.cam_label_pos': 'Øverst står mærket ved siden af titlen. Nederst står det over den tekniske udlæsning. Vælg Skjult for at undvære det her. Standard er øverst til venstre.',
        'help.cam_label_pos_small': 'Gælder miniaturerne i Fokus + strip og fliserne i gitteret. Her er der trangt, så Skjult kan være en god idé.',
        'help.cam_label_pos_fs': 'Gælder kameraet, mens kortet er i fuldskærm.',
        'help.url': 'Fx hoveddor_hd',
        'help.layout': 'Automatisk giver fokus + strip ved flere kameraer og enkelt ved ét kamera',
        'help.auto_quality': 'Miniaturer og gitter bruger den sidste stream (SD). Det store kamera og fuldskærm bruger den første (HD).',
        'help.intro': 'Afspilles, når kortet indlæses. Billedet vises først, når streamen kører.',
        'help.carousel_pause': 'En lille knap under kvalitetsknappen, der holder karrusellen, til du trykker igen',
        'help.carousel': 'Skifter det viste kamera. Pauser, når du bruger kortet, når privatliv er slået til (kameraet springes over), og når fanen er skjult eller kortet uden for syne.',
        'help.switch_effect': 'Det gamle billede holdes frosset og afløses af det nye. Glid betyder i Enkelt, at billedet skubbes, og i Fokus + strip, at fliserne glider. Hastigheden følger opstartens. Skifte mellem HD og SD bruger altid den bløde overgang. Farve-effekterne følger accentfarven fra Udseende. Tilfældig vælger en ny effekt ved hvert skift. Standard er Blød i Enkelt og Glid i Fokus.',
        'help.fullscreen_nav': 'Gælder alle layouts. Slået fra viser fuldskærm kun det kamera, man åbnede.',
        'help.fullscreen_nav_modes': 'Pile og prikker ligger nederst i midten. Miniaturer er små billeder af kameraerne langs kanten. Swipe er på touch, og piletaster er på computer.',
        'help.fullscreen_carousel': 'Karrusellen skifter også kamera, mens kortet er i fuldskærm.',
        'help.camera_nav': 'Pilene vises ved hover på computer og svagt på touch. På touch kan man også swipe.',
        'help.corner_radius': 'Standard følger Home Assistants egen kortradius (typisk 12 px)',
        'help.readout': 'Vises nederst på det store kamera. Fps og bitrate måles ved WebRTC (bitrate også ved MSE). Vælg ingen for at skjule udlæsningen.',
        'help.pip': 'Standard er kun på computer. Aldrig skjuler kun kortets egen knap. Kun kortets egen knap skjuler browserens knap (fx Firefoxs lille PiP-knap på højre kant) og beholder kortets. Slået fra slår billede-i-billede helt fra på videoen.',
        'help.pause_offscreen': 'Streamen stopper, når kortet scrolles ud af syne eller fanen skjules. Slået fra kører den også uden for syne, men stopper stadig i en skjult fane.',
        'help.pause_offscreen_off_bg': 'Overstyres af "Stop aldrig streams" nedenfor.',
        'help.fullscreen_pause_others_off_bg': 'Overstyres af "Stop aldrig streams" nedenfor.',
        'help.background': 'Streamen stopper aldrig, heller ikke når kortet er uden for syne, fanen er skjult eller kameraet er skjult i fuldskærm. Bruger mere netværk og strøm. Overstyrer de to pauseindstillinger ovenfor. Billede-i-billede slår den selv til, mens det er åbent.',
        'help.fullscreen_pause_others': 'Sparer netværk og regnekraft, f.eks. på en tablet, der står i fuldskærm. De kameraer, du ikke ser, lukker forbindelsen og åbner den igen, når de skal vises, så kameraskift kan tage et øjeblik længere, og miniaturerne i bjælken står stille.',
        'help.fullscreen_pause_others_off': 'Ikke tilgængelig, mens karrusellen skifter kamera i fuldskærm (alle kameraer ville forbinde igen hver gang). Slå "Karrusel fortsætter i fuldskærm" fra for at bruge den.',
        'help.server': 'Kun hvis streamen ligger på en anden go2rtc end integrationens',
        'help.poster': 'Vises, mens streamen indlæses (valgfri)',
        'help.privacy': 'Fx switch.kamera_hoveddor_privacy. Efterlad tom for ikke at bruge den.',
        'help.preset': 'Fx select.kamera_hoveddor_move_to_preset. Efterlad tom for ikke at vise presets.',
        'help.patrol': 'Fx switch.kamera_hoveddor_preset_patrol_mode',
        'help.patrol_mode': 'Fx select.kamera_hoveddor_patrol_mode (Horizontal/Vertical)',
        'help.light': 'Fx light.kamera_hoveddor_floodlight_timed',
        'help.control_panel': 'Panelet vises kun på det store kamera og kun med entiteter, der er valgt under kameraet.',
        'help.preset_style': 'Automatisk viser knapper op til seks presets og derefter en dropdown.',
        'help.privacy_cover_quality': 'Kun for de animerede dæksler. Højere er skarpere på skarpe skærme, men bruger mere hukommelse, mens privatliv er slået til.',
        'help.privacy_cover_small': 'Miniaturer og gitterfliser animerer også (lidt langsommere). Slå fra for kun at animere det store kamera.',
        'help.privacy_cover': 'Vises over billedet, mens privatliv er slået til. Animationerne bruger accentfarven og kører som standard også på små kameraer (se næste indstilling).',
        'help.left': 'Knap-entitet, fx button.kamera_hoveddor_move_left',
        // o
        'o.still_size.medium': 'Mellem (1280 px, anbefalet)',
        'o.still_size.small': 'Lille (640 px, lettest)',
        'o.still_size.full': 'Videoens fulde opløsning',
        'o.ui.own': 'Egne knapper',
        'o.ui.browser': 'Browserens egne kontroller',
        'o.ui.none': 'Ingen (rent billede)',
        'o.mode.auto': 'Automatisk',
        'o.mode.webrtc': 'WebRTC',
        'o.mode.mse': 'MSE',
        'o.mode.hls': 'HLS',
        'o.mode.mjpeg': 'MJPEG',
        'o.layout.auto': 'Automatisk',
        'o.layout.focus': 'Fokus + strip',
        'o.layout.grid': 'Gitter',
        'o.layout.single': 'Enkelt (ét kamera ad gangen)',
        'o.switch_effect.soft': 'Blød overgang',
        'o.switch_effect.zoom': 'Zoom',
        'o.switch_effect.flip': 'Vend',
        'o.switch_effect.pixel': 'Pixel',
        'o.switch_effect.cube': 'Terning (3D)',
        'o.switch_effect.push': 'Skub over',
        'o.switch_effect.spin': 'Drej og zoom',
        'o.switch_effect.roll': 'Rul',
        'o.switch_effect.blur': 'Slør',
        'o.switch_effect.glitch': 'Glitch',
        'o.switch_effect.mosaic': 'Mosaik',
        'o.switch_effect.noise': 'Støj',
        'o.switch_effect.wash': 'Farvevisker (farve)',
        'o.switch_effect.tint': 'Farvefilter (farve)',
        'o.switch_effect.ripple': 'Krusning (farve)',
        'o.switch_effect.random': 'Tilfældig',
        'o.switch_effect.none': 'Ingen effekt',
        'o.fullscreen_nav_modes.arrows': 'Pile og prikker',
        'o.fullscreen_nav_modes.thumbs': 'Miniaturer langs kanten',
        'o.fullscreen_nav_modes.swipe': 'Swipe (touch)',
        'o.fullscreen_nav_modes.keys': 'Piletaster (computer)',
        'o.nav_position.bottom': 'Nederst (pille med prikker)',
        'o.nav_position.sides': 'I siderne',
        'o.carousel_interval.5': '5 sekunder',
        'o.carousel_interval.10': '10 sekunder',
        'o.carousel_interval.15': '15 sekunder',
        'o.carousel_interval.30': '30 sekunder',
        'o.carousel_interval.60': '1 minut',
        'o.strip.auto': 'Automatisk',
        'o.strip.right': 'Til højre',
        'o.strip.bottom': 'Nederst',
        'o.grid_columns.auto': 'Automatisk',
        'o.intro.focus': 'Fokus ind',
        'o.intro.boot': 'Boot-tekst',
        'o.intro.frame': 'Rammetegning',
        'o.intro.scan': 'Lysstribe',
        'o.intro.iris': 'Cirkel',
        'o.intro.tv': 'Tv-tænd',
        'o.intro.blinds': 'Persienner',
        'o.intro.none': 'Ingen',
        'o.accent_color.ice': 'Isblå',
        'o.accent_color.white': 'Hvid',
        'o.accent_color.green': 'Grøn',
        'o.accent_color.amber': 'Rav',
        'o.accent_color.red': 'Rød',
        'o.accent_color.violet': 'Violet',
        'o.accent_color.primary': 'Følg HAs primærfarve',
        'o.accent_color.custom': 'Egen farve',
        'o.intro_speed.fast': 'Hurtig',
        'o.intro_speed.normal': 'Normal',
        'o.intro_speed.slow': 'Langsom',
        'o.cam_label_pos.top-left': 'Øverst til venstre',
        'o.cam_label_pos.top-center': 'Øverst i midten',
        'o.cam_label_pos.top-right': 'Øverst til højre',
        'o.cam_label_pos.bottom-left': 'Nederst til venstre',
        'o.cam_label_pos.bottom-center': 'Nederst i midten',
        'o.cam_label_pos.bottom-right': 'Nederst til højre',
        'o.cam_label_pos.hidden': 'Skjult',
        'o.cam_label_style.pill': 'Pille',
        'o.cam_label_style.tab': 'Fyldt fane',
        'o.cam_label_style.line': 'Linje',
        'o.cam_label_style.bar': 'Streg',
        'o.cam_label_style.text': 'Kun tekst',
        'o.cam_label_style.outline': 'Kontur',
        'o.cam_label_style.corners': 'Hjørner',
        'o.cam_label_style.glass': 'Glas',
        'o.cam_label_style.dot': 'Prik',
        'o.cam_label_color.auto': 'Følger stilen',
        'o.cam_label_color.white': 'Hvid',
        'o.cam_label_color.accent': 'Accentfarven',
        'o.cam_label_color.custom': 'Egen farve',
        'o.cam_label_text.number': 'CAM-nummer (eller egen tekst)',
        'o.cam_label_text.name': 'Kameraets navn',
        'o.cam_label_readout_color.own': 'Egen stil',
        'o.cam_label_readout_color.label': 'Som mærket',
        'o.title_position.top-left': 'Øverst til venstre',
        'o.title_position.top-center': 'Øverst i midten',
        'o.title_position.top-right': 'Øverst til højre',
        'o.title_position.bottom-center': 'Nederst i midten',
        'o.title_position.hidden': 'Skjult',
        'o.readout.connection': 'Forbindelse (RTC/MSE)',
        'o.readout.resolution': 'Opløsning',
        'o.readout.fps': 'Billeder pr. sekund',
        'o.readout.bitrate': 'Bitrate',
        'o.readout.clock': 'Klokkeslæt',
        'o.preset_style.auto': 'Automatisk',
        'o.preset_style.buttons': 'Valgknapper',
        'o.preset_style.dropdown': 'Dropdown',
        'o.privacy_cover.black': 'Sort med lås',
        'o.privacy_cover.blur': 'Sløring',
        'o.privacy_cover.network': 'Netværk',
        'o.privacy_cover.stream': 'Datastrøm',
        'o.privacy_cover.radar': 'Radar',
        'o.privacy_cover.cams': 'Kameranet',
        'o.privacy_cover.clock': 'Ur',
        'o.privacy_cover.none': 'Ingen (kun afbryderen)',
        'o.privacy_cover_quality.low': 'Spar hukommelse',
        'o.privacy_cover_quality.normal': 'Normal',
        'o.privacy_cover_quality.high': 'Skarp (følger skærmen)',
        'o.pip.auto': 'Kun på computer',
        'o.pip.always': 'Altid',
        'o.pip.never': 'Aldrig',
        'o.pip.own': 'Kun kortets egen knap (skjuler browserens)',
        'o.pip.off': 'Slået fra (skjuler også kortets knap)',
        'o.switch_effect.slide_single': 'Glid (billedet skubbes)',
        'o.switch_effect.slide_grid': 'Glid (fliserne glider på plads)',
        // tile
        'tile.cant_connect': 'Kan ikke forbinde',
        'tile.conn_failed': 'Kunne ikke forbinde. Er WebRTC Camera-integrationen installeret, og findes streamen?',
        'tile.control_panel': 'Kontrolpanel',
        'tile.carousel_pause': 'Pause karrusel',
        'tile.carousel_resume': 'Fortsæt karrusel',
        // camera
        'camera': 'Kamera',
        // camera_n
        'camera_n': 'Kamera {0}',
        // tile
        'tile.no_stream': 'Ingen stream valgt. Åbn kortets editor og tilføj en stream.',
        'tile.privacy_on': 'Privatliv er slået til',
        'tile.cp.privacy': 'Privatliv',
        'tile.cp.position': 'Position',
        'tile.cp.patrol': 'Patrulje',
        'tile.cp.patrol_mode': 'Patruljeretning',
        'tile.cp.light': 'Projektørlys',
        'tile.cp.none': 'Ingen styringer fundet',
        'tile.error': 'Fejl',
        // invalid_config
        'invalid_config': 'Ugyldig konfiguration',
        // tile
        'tile.prev_cam': 'Forrige kamera',
        'tile.next_cam': 'Næste kamera',
        'tile.boot_connecting': 'FORBINDER {0} ...',
        // ed
        'ed.add_camera': '+ Tilføj kamera',
        'ed.layout_note': 'Strip, gitter og mellemrum vises, når kortet har mere end ét kamera.',
        'ed.panel_note': 'Hvilke entiteter der vises i panelet vælges pr. kamera under Kameraer, i sektionen Kamerastyring.',
        'ed.streams': 'Streams',
        'ed.add_stream': '+ Tilføj stream',
        'ed.ptz_head': 'PTZ (kameradrejning)',
        'ed.ptz_note': 'PTZ bruger en anden service end button.press. Den redigeres i YAML.',
        'ed.ctl_head': 'Kamerastyring (privatliv, presets, patrulje, lys)',
        'ed.ctl_note': 'Vælg én entitet, så foreslår editoren de andre ud fra navnet. Tomme felter vises ikke i panelet.',
        'ed.move_up_title': 'Flyt op',
        'ed.move_up': '↑ Op',
        'ed.move_down_title': 'Flyt ned',
        'ed.move_down': '↓ Ned',
        'ed.remove_camera': 'Fjern kamera',
        'ed.remove_stream': 'Fjern stream',
        'ed.controls_badge': 'Kamerastyring',
        'ed.tab_cams_n': 'Kameraer ({0})',
        // tab
        'tab.cams': 'Kameraer',
        'tab.layout': 'Layout',
        'tab.intro': 'Opstart',
        'tab.look': 'Udseende',
        'tab.panel': 'Styring',
        'tab.controls': 'Knapper',
        'tab.adv': 'Avanceret',
    },
    };

    let LANG = 'en';
    /** Sætter sproget ud fra hass (eller gemt sprog i browseren). Giver true, hvis sproget skiftede. */
    const setLang = hass => {
        let l = hass && ((hass.locale && hass.locale.language) || hass.language);
        if (!l) {
            try { l = JSON.parse(localStorage.getItem('selectedLanguage')); } catch (e) { l = null; }
        }
        l = String(l || (typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase().slice(0, 2);
        const next = STRINGS[l] ? l : 'en';
        const changed = next !== LANG;
        LANG = next;
        return changed;
    };
    const trOr = (key, fallback) => {
        const v = STRINGS[LANG][key] !== undefined ? STRINGS[LANG][key] : STRINGS.en[key];
        return v !== undefined ? v : fallback;
    };
    const tr = (key, ...args) => trOr(key, key).replace(/\{(\d+)\}/g, (m, i) => args[+i] !== undefined ? args[+i] : m);
    setLang(null);

    const MODE_OPTIONS = () => [
        {value: 'auto', label: tr('o.mode.auto')},
        {value: 'webrtc', label: tr('o.mode.webrtc')},
        {value: 'mse', label: tr('o.mode.mse')},
        {value: 'hls', label: tr('o.mode.hls')},
        {value: 'mjpeg', label: tr('o.mode.mjpeg')},
    ];

    const CAM_SCHEMA = [{name: 'name', selector: {text: {}}}, {name: 'label', selector: {text: {}}}];

    const STREAM_SCHEMA = () => [{
        type: 'grid',
        name: '',
        schema: [
            {name: 'name', selector: {text: {}}},
            {name: 'url', selector: {text: {}}},
            {name: 'mode', selector: {select: {options: MODE_OPTIONS(), mode: 'dropdown'}}},
        ],
    }];

    const sel = (name, options) => ({name, selector: {select: {options, mode: 'dropdown'}}});
    const bool = name => ({name, selector: {boolean: {}}});

    const LAYOUT_OPTIONS = () => [
        {value: 'auto', label: tr('o.layout.auto')},
        {value: 'focus', label: tr('o.layout.focus')},
        {value: 'grid', label: tr('o.layout.grid')},
        {value: 'single', label: tr('o.layout.single')},
    ];

    /** Layout-felterne afhænger af antal kameraer og valgt layout. */
    const fxSelect = layout => sel('switch_effect', [
        {value: 'soft', label: tr('o.switch_effect.soft')},
        {value: 'slide', label: tr(layout === 'single' ? 'o.switch_effect.slide_single' : 'o.switch_effect.slide_grid')},
        {value: 'zoom', label: tr('o.switch_effect.zoom')},
        {value: 'flip', label: tr('o.switch_effect.flip')},
        {value: 'pixel', label: tr('o.switch_effect.pixel')},
        {value: 'cube', label: tr('o.switch_effect.cube')},
        {value: 'push', label: tr('o.switch_effect.push')},
        {value: 'spin', label: tr('o.switch_effect.spin')},
        {value: 'roll', label: tr('o.switch_effect.roll')},
        {value: 'blur', label: tr('o.switch_effect.blur')},
        {value: 'glitch', label: tr('o.switch_effect.glitch')},
        {value: 'mosaic', label: tr('o.switch_effect.mosaic')},
        {value: 'noise', label: tr('o.switch_effect.noise')},
        {value: 'wash', label: tr('o.switch_effect.wash')},
        {value: 'tint', label: tr('o.switch_effect.tint')},
        {value: 'ripple', label: tr('o.switch_effect.ripple')},
        {value: 'random', label: tr('o.switch_effect.random')},
        {value: 'none', label: tr('o.switch_effect.none')},
    ]);

    /** Standard for effekten afhænger af layout: Enkelt er blød, Fokus + strip glider som før. */
    const fxDefault = layout => layout === 'single' ? 'soft' : 'slide';

    const fsFields = (count, fsNav) => {
        if (count < 2) return [];
        const f = [bool('fullscreen_nav')];
        if (fsNav) {
            f.push({name: 'fullscreen_nav_modes', selector: {select: {multiple: true, mode: 'list', options: [
                {value: 'arrows', label: tr('o.fullscreen_nav_modes.arrows')},
                {value: 'thumbs', label: tr('o.fullscreen_nav_modes.thumbs')},
                {value: 'swipe', label: tr('o.fullscreen_nav_modes.swipe')},
                {value: 'keys', label: tr('o.fullscreen_nav_modes.keys')},
            ]}}});
        }
        return f;
    };

    const layoutSchema = (count, layout, carousel, fsNav) => {
        const s = [sel('layout', LAYOUT_OPTIONS())];
        if (count >= 2 && layout === 'single') {
            s.push(fxSelect(layout));
            s.push(bool('camera_nav'));
            s.push(sel('nav_position', [
                {value: 'bottom', label: tr('o.nav_position.bottom')},
                {value: 'sides', label: tr('o.nav_position.sides')},
            ]));
        }
        if (count >= 2 && layout === 'single') {
            s.push(bool('carousel'));
            if (carousel) {
                s.push(sel('carousel_interval', [
                    {value: '5', label: tr('o.carousel_interval.5')},
                    {value: '10', label: tr('o.carousel_interval.10')},
                    {value: '15', label: tr('o.carousel_interval.15')},
                    {value: '30', label: tr('o.carousel_interval.30')},
                    {value: '60', label: tr('o.carousel_interval.60')},
                ]));
                s.push(bool('carousel_bar'));
                s.push(bool('carousel_pause'));
                s.push(bool('fullscreen_carousel'));
            }
        }
        if (count < 2 || layout === 'single') return s.concat(fsFields(count, fsNav));
        s.push(fxSelect(layout));
        if (layout !== 'grid') {
            s.push(sel('strip', [
                {value: 'auto', label: tr('o.strip.auto')},
                {value: 'right', label: tr('o.strip.right')},
                {value: 'bottom', label: tr('o.strip.bottom')},
            ]));
        }
        if (layout === 'grid') {
            s.push(sel('grid_columns', [
                {value: 'auto', label: tr('o.grid_columns.auto')},
                {value: '1', label: '1'},
                {value: '2', label: '2'},
                {value: '3', label: '3'},
                {value: '4', label: '4'},
            ]));
        }
        s.push({name: 'gap', selector: {number: {min: 0, max: 40, step: 1, mode: 'slider', unit_of_measurement: 'px'}}});
        s.push(bool('auto_quality'));
        if (layout !== 'grid') s.push(bool('animations'));
        if (layout !== 'grid') {
            s.push(bool('carousel'));
            if (carousel) {
                s.push(sel('carousel_interval', [
                    {value: '5', label: tr('o.carousel_interval.5')},
                    {value: '10', label: tr('o.carousel_interval.10')},
                    {value: '15', label: tr('o.carousel_interval.15')},
                    {value: '30', label: tr('o.carousel_interval.30')},
                    {value: '60', label: tr('o.carousel_interval.60')},
                ]));
                s.push(bool('carousel_bar'));
                s.push(bool('carousel_pause'));
                s.push(bool('fullscreen_carousel'));
            }
        }
        return s.concat(fsFields(count, fsNav));
    };

    const INTRO_OPTIONS = () => [
        {value: 'focus', label: tr('o.intro.focus')},
        {value: 'boot', label: tr('o.intro.boot')},
        {value: 'frame', label: tr('o.intro.frame')},
        {value: 'scan', label: tr('o.intro.scan')},
        {value: 'iris', label: tr('o.intro.iris')},
        {value: 'tv', label: tr('o.intro.tv')},
        {value: 'blinds', label: tr('o.intro.blinds')},
        {value: 'none', label: tr('o.intro.none')},
    ];

    const INTRO_COLOR_OPTIONS = () => [
        {value: 'ice', label: tr('o.accent_color.ice')},
        {value: 'white', label: tr('o.accent_color.white')},
        {value: 'green', label: tr('o.accent_color.green')},
        {value: 'amber', label: tr('o.accent_color.amber')},
        {value: 'red', label: tr('o.accent_color.red')},
        {value: 'violet', label: tr('o.accent_color.violet')},
        {value: 'primary', label: tr('o.accent_color.primary')},
        {value: 'custom', label: tr('o.accent_color.custom')},
    ];

    /** Hastigheden vises kun, når der er en opstart. */
    const introSchema = intro => {
        const s = [sel('intro', INTRO_OPTIONS())];
        if (intro === 'none') return s;
        s.push(sel('intro_speed', [
            {value: 'fast', label: tr('o.intro_speed.fast')},
            {value: 'normal', label: tr('o.intro_speed.normal')},
            {value: 'slow', label: tr('o.intro_speed.slow')},
        ]));
        return s;
    };

    const CL_OPTIONS = () => [
        {value: 'top-left', label: tr('o.cam_label_pos.top-left')},
        {value: 'top-center', label: tr('o.cam_label_pos.top-center')},
        {value: 'top-right', label: tr('o.cam_label_pos.top-right')},
        {value: 'bottom-left', label: tr('o.cam_label_pos.bottom-left')},
        {value: 'bottom-center', label: tr('o.cam_label_pos.bottom-center')},
        {value: 'bottom-right', label: tr('o.cam_label_pos.bottom-right')},
        {value: 'hidden', label: tr('o.cam_label_pos.hidden')},
    ];

    // Udseende: accentfarven først (bruges overalt), derefter CAM-mærket og titlen. Egen farve og mærkets valg vises kun, når de giver mening.
    const lookSchema = (color, label, lcolor, lro) => [
        sel('accent_color', INTRO_COLOR_OPTIONS()),
        ...(color === 'custom' ? [{name: 'accent_color_custom', selector: {color_rgb: {}}}] : []),
        bool('cam_label'),
        ...(label ? [
            sel('cam_label_style', [
                {value: 'pill', label: tr('o.cam_label_style.pill')},
                {value: 'tab', label: tr('o.cam_label_style.tab')},
                {value: 'line', label: tr('o.cam_label_style.line')},
                {value: 'bar', label: tr('o.cam_label_style.bar')},
                {value: 'text', label: tr('o.cam_label_style.text')},
                {value: 'outline', label: tr('o.cam_label_style.outline')},
                {value: 'corners', label: tr('o.cam_label_style.corners')},
                {value: 'glass', label: tr('o.cam_label_style.glass')},
                {value: 'dot', label: tr('o.cam_label_style.dot')},
            ]),
            sel('cam_label_color', [
                {value: 'auto', label: tr('o.cam_label_color.auto')},
                {value: 'white', label: tr('o.cam_label_color.white')},
                {value: 'accent', label: tr('o.cam_label_color.accent')},
                {value: 'custom', label: tr('o.cam_label_color.custom')},
            ]),
            ...(lcolor === 'custom' ? [{name: 'cam_label_color_custom', selector: {color_rgb: {}}}] : []),
            sel('cam_label_text', [
                {value: 'number', label: tr('o.cam_label_text.number')},
                {value: 'name', label: tr('o.cam_label_text.name')},
            ]),
            sel('cam_label_pos', CL_OPTIONS()),
            sel('cam_label_pos_small', CL_OPTIONS()),
            sel('cam_label_pos_fs', CL_OPTIONS()),
            {name: 'cam_label_offset', selector: {number: {min: 0, max: 100, step: 1, mode: 'slider', unit_of_measurement: 'px'}}},
            {name: 'cam_label_side', selector: {number: {min: 0, max: 100, step: 1, mode: 'slider', unit_of_measurement: 'px'}}},
            bool('cam_label_readout'),
            ...(lro ? [sel('cam_label_readout_color', [
                {value: 'own', label: tr('o.cam_label_readout_color.own')},
                {value: 'label', label: tr('o.cam_label_readout_color.label')},
            ])] : []),
        ] : []),
        sel('title_position', [
            {value: 'top-left', label: tr('o.title_position.top-left')},
            {value: 'top-center', label: tr('o.title_position.top-center')},
            {value: 'top-right', label: tr('o.title_position.top-right')},
            {value: 'bottom-center', label: tr('o.title_position.bottom-center')},
            {value: 'hidden', label: tr('o.title_position.hidden')},
        ]),
        {name: 'title_offset', selector: {number: {min: 0, max: 100, step: 1, mode: 'slider', unit_of_measurement: 'px'}}},
        {name: 'corner_radius', selector: {number: {min: 0, max: 32, step: 1, mode: 'slider', unit_of_measurement: 'px'}}},
        {name: 'aspect_ratio', selector: {text: {}}},
        {name: 'readout', selector: {select: {multiple: true, mode: 'list', options: [
            {value: 'connection', label: tr('o.readout.connection')},
            {value: 'resolution', label: tr('o.readout.resolution')},
            {value: 'fps', label: tr('o.readout.fps')},
            {value: 'bitrate', label: tr('o.readout.bitrate')},
            {value: 'clock', label: tr('o.readout.clock')},
        ]}}},
    ];

    const PANEL_SCHEMA = () => [
        bool('control_panel'),
        sel('preset_style', [
            {value: 'auto', label: tr('o.preset_style.auto')},
            {value: 'buttons', label: tr('o.preset_style.buttons')},
            {value: 'dropdown', label: tr('o.preset_style.dropdown')},
        ]),
        sel('privacy_cover', [
            {value: 'black', label: tr('o.privacy_cover.black')},
            {value: 'blur', label: tr('o.privacy_cover.blur')},
            {value: 'network', label: tr('o.privacy_cover.network')},
            {value: 'stream', label: tr('o.privacy_cover.stream')},
            {value: 'radar', label: tr('o.privacy_cover.radar')},
            {value: 'cams', label: tr('o.privacy_cover.cams')},
            {value: 'clock', label: tr('o.privacy_cover.clock')},
            {value: 'none', label: tr('o.privacy_cover.none')},
        ]),
        bool('privacy_cover_small'),
        sel('privacy_cover_quality', [
            {value: 'low', label: tr('o.privacy_cover_quality.low')},
            {value: 'normal', label: tr('o.privacy_cover_quality.normal')},
            {value: 'high', label: tr('o.privacy_cover_quality.high')},
        ]),
    ];

    const CONTROLS_SCHEMA = (uiMode = 'own') => [
        sel('ui', [
            {value: 'own', label: tr('o.ui.own')},
            {value: 'browser', label: tr('o.ui.browser')},
            {value: 'none', label: tr('o.ui.none')},
        ]),
        // Billede-i-billede-knappen hører til kortets egne knapper
        ...(uiMode === 'own' ? [sel('pip', [
            {value: 'auto', label: tr('o.pip.auto')},
            {value: 'always', label: tr('o.pip.always')},
            {value: 'never', label: tr('o.pip.never')},
            {value: 'own', label: tr('o.pip.own')},
            {value: 'off', label: tr('o.pip.off')},
        ])] : []),
        bool('digital_zoom'),
        bool('double_tap_zoom'),
        bool('muted'),
    ];

    /** multi: flere kameraer i et layout med flere fliser; blocked: fuldskærmskarrusel kører; bg: "Stop aldrig streams" er slået til (overstyrer pauserne). */
    const ADV_SCHEMA = (multi, blocked, bg) => [
        {name: 'pause_offscreen', selector: {boolean: {}}, disabled: !!bg, reason: 'bg'},
        ...(multi ? [{name: 'fullscreen_pause_others', selector: {boolean: {}}, disabled: !!(blocked || bg), reason: bg ? 'bg' : 'car'}] : []),
        bool('background'),
        bool('show_status'),
        sel('mode', MODE_OPTIONS()),
        sel('still_size', [
            {value: 'medium', label: tr('o.still_size.medium')},
            {value: 'small', label: tr('o.still_size.small')},
            {value: 'full', label: tr('o.still_size.full')},
        ]),
        {name: 'server', selector: {text: {}}},
        {name: 'poster', selector: {text: {}}},
    ];

    const CTL_SCHEMA = [
        {name: 'privacy', selector: {entity: {domain: 'switch'}}},
        {name: 'preset', selector: {entity: {domain: 'select'}}},
        {name: 'patrol', selector: {entity: {domain: 'switch'}}},
        {name: 'patrol_mode', selector: {entity: {domain: 'select'}}},
        {name: 'light', selector: {entity: {domain: 'light'}}},
    ];
    const PTZ_TOGGLE = [bool('enabled')];
    const PTZ_FIELDS = DIRS.map(d => ({name: d, selector: {entity: {domain: 'button'}}}));

    /** Standardværdier. En indstilling skrives kun i YAML, hvis den afviger fra dem. */
    const FIELD_DEF = {
        layout: 'auto', strip: 'auto', grid_columns: undefined, gap: 8, auto_quality: true, animations: true,
        intro: 'focus', intro_speed: 'normal',
        accent_color: 'primary', accent_color_custom: '', cam_label: false, cam_label_style: 'pill', cam_label_text: 'number', cam_label_pos: 'top-left', cam_label_pos_small: 'top-left', cam_label_pos_fs: 'top-left', cam_label_offset: 14, cam_label_side: 12, cam_label_color: 'auto', cam_label_color_custom: '', cam_label_readout: false, cam_label_readout_color: 'own', corner_radius: 12, readout: ['connection', 'resolution', 'clock'], camera_nav: true, nav_position: 'bottom', switch_effect: 'soft', carousel: false, carousel_interval: 10, carousel_bar: true, carousel_pause: true, fullscreen_carousel: true, fullscreen_nav: true, fullscreen_nav_modes: ['arrows', 'swipe', 'keys'], title_position: 'top-center', title_offset: 14, aspect_ratio: '16/9',
        control_panel: true, preset_style: 'auto', privacy_cover: 'black', privacy_cover_small: true, privacy_cover_quality: 'normal', ui: 'own', pip: 'auto', digital_zoom: true, double_tap_zoom: true, muted: true,
        pause_offscreen: true, fullscreen_pause_others: false, background: false, show_status: false, mode: 'auto', still_size: 'medium', server: '', poster: '',
    };

    const TABS = [
        {id: 'cams', icon: 'mdi:cctv'},
        {id: 'layout', icon: 'mdi:view-dashboard-outline'},
        {id: 'intro', icon: 'mdi:movie-open-play-outline'},
        {id: 'look', icon: 'mdi:eye-outline'},
        {id: 'panel', icon: 'mdi:tune-variant'},
        {id: 'controls', icon: 'mdi:gesture-tap-button'},
        {id: 'adv', icon: 'mdi:cog-outline'},
    ];

    // Felter pr. formular-fane (dem der hentes fra og skrives til konfigurationen)
    const TAB_FIELDS = {
        layout: ['layout', 'switch_effect', 'camera_nav', 'nav_position', 'carousel', 'carousel_interval', 'carousel_bar', 'carousel_pause', 'fullscreen_carousel', 'fullscreen_nav', 'fullscreen_nav_modes', 'strip', 'grid_columns', 'gap', 'auto_quality', 'animations'],
        intro: ['intro', 'intro_speed'],
        look: ['accent_color', 'accent_color_custom', 'cam_label', 'cam_label_style', 'cam_label_text', 'cam_label_pos', 'cam_label_pos_small', 'cam_label_pos_fs', 'cam_label_offset', 'cam_label_side', 'cam_label_color', 'cam_label_color_custom', 'cam_label_readout', 'cam_label_readout_color', 'title_position', 'title_offset', 'corner_radius', 'aspect_ratio', 'readout'],
        panel: ['control_panel', 'preset_style', 'privacy_cover', 'privacy_cover_small', 'privacy_cover_quality'],
        controls: ['ui', 'pip', 'digital_zoom', 'double_tap_zoom', 'muted'],
        adv: ['pause_offscreen', 'fullscreen_pause_others', 'background', 'show_status', 'mode', 'still_size', 'server', 'poster'],
    };

    const EDITOR_CSS = `
        :host { display: block; }
        [hidden] { display: none !important; }
        .tabs {
            display: flex;
            gap: 2px;
            margin-bottom: 16px;
            border-bottom: 1px solid var(--divider-color);
            overflow-x: auto;
        }
        .tab {
            flex: 1 0 auto;
            min-width: 62px;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;
            padding: 8px 8px 6px;
            background: none;
            border: 0;
            border-bottom: 2px solid transparent;
            border-radius: 8px 8px 0 0;
            color: var(--secondary-text-color);
            font: inherit;
            font-size: 12px;
            cursor: pointer;
        }
        .tab ha-icon { --mdc-icon-size: 22px; }
        .tab:hover { background: var(--secondary-background-color); }
        .tab.active { color: var(--primary-color); border-bottom-color: var(--primary-color); }
        .subh { font-weight: 500; font-size: 14px; margin: 12px 0 6px; color: var(--secondary-text-color); }
        .note { font-size: 13px; color: var(--secondary-text-color); margin: 4px 0 8px; }
        .row { border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }

        .cam { border: 1px solid var(--divider-color); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
        .cam.open { border-color: var(--primary-color); }
        .cam-head {
            width: 100%;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            background: none;
            border: 0;
            color: var(--primary-text-color);
            font: inherit;
            text-align: left;
            cursor: pointer;
        }
        .cam-head:hover { background: var(--secondary-background-color); }
        .cam-head .ci { color: var(--secondary-text-color); }
        .cam.open .cam-head .ci { color: var(--primary-color); }
        .cn { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .badges { display: flex; align-items: center; gap: 6px; color: var(--secondary-text-color); font-size: 12px; }
        .badges ha-icon { --mdc-icon-size: 16px; }
        .chev { color: var(--secondary-text-color); transition: transform 0.2s; }
        .cam.open .chev { transform: rotate(180deg); }
        .cam-body { padding: 4px 12px 12px; border-top: 1px solid var(--divider-color); }
        .cam-body .row { border-style: dashed; }
        .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
        .btn {
            cursor: pointer;
            background: transparent;
            color: var(--primary-color);
            border: 1px solid var(--primary-color);
            border-radius: 8px;
            padding: 6px 12px;
            font: inherit;
            font-size: 14px;
        }
        .btn.sm { padding: 3px 10px; }
        .btn:disabled { opacity: 0.35; cursor: default; }
        .btn.del { color: var(--error-color); border-color: var(--error-color); margin-top: 4px; }
        .btn.rm { color: var(--error-color); border-color: var(--error-color); margin-left: auto; }
    `;

    class PanoptesCardEditor extends HTMLElement {
        constructor() {
            super();
            this._config = {};
            this._hass = null;
            this._built = false;
            this._tab = 'cams';
            this._open = 0;          // hvilket kamera der er foldet ud (-1 = ingen)
            this._layoutKey = '';
            this._introKey = '';
            this._lookKey = '';
        }

        set hass(hass) {
            this._hass = hass;
            if (setLang(hass) && this._built) {
                // Sproget skiftede efter opbygningen: bygges igen, så alle tekster passer
                this._built = false;
                this._lookKey = this._introKey = this._layoutKey = '';
                this._build();
                this._sync();
            }
            this._forms().forEach(f => {
                f.hass = hass;
            });
        }

        get hass() {
            return this._hass;
        }

        connectedCallback() {
            // Sørger for, at HAs egne felter (entity-vælger m.fl.) er indlæst
            if (window.loadCardHelpers) {
                window.loadCardHelpers()
                    .then(h => h.createCardElement({type: 'entities', entities: []}))
                    .then(c => c && c.constructor && c.constructor.getConfigElement && c.constructor.getConfigElement())
                    .catch(() => {});
            }
        }

        setConfig(config) {
            this._config = clone(config || {});
            this._normalize();
            if (!this._built) this._build();
            this._sync();
        }

        /**
         * Editoren arbejder altid på cameras:-listen. Et gammelt format med streams: direkte på
         * kortet omskrives her. Det gemmes først, når man ændrer noget i editoren.
         */
        _normalize() {
            const c = this._config;
            if (!Array.isArray(c.cameras)) {
                const cam = {};
                const nm = c.name || c.title;
                if (nm) cam.name = nm;
                let streams = c.streams;
                if (!Array.isArray(streams)) streams = (c.url || c.entity) ? [{url: c.url, entity: c.entity}] : [];
                if (streams.length) cam.streams = streams.map(s => typeof s === 'string' ? {url: s} : s);
                if (c.ptz) cam.ptz = c.ptz;
                ['name', 'title', 'streams', 'url', 'entity', 'ptz'].forEach(k => delete c[k]);
                c.cameras = [cam];
            } else {
                if (!c.cameras.length) c.cameras.push({});
                if (c.ptz && !c.cameras[0].ptz) {
                    c.cameras[0].ptz = c.ptz;
                    delete c.ptz;
                }
            }
            c.cameras.forEach(cam => {
                if (cam.title && !cam.name) cam.name = cam.title;
                delete cam.title;
            });
        }

        /* ---------- Hjælpere til konfigurationen ---------- */

        _forms() {
            return this.shadowRoot ? Array.from(this.shadowRoot.querySelectorAll('ha-form')) : [];
        }

        _streams(cam) {
            if (Array.isArray(cam.streams)) return cam.streams.map(s => typeof s === 'string' ? {url: s} : s);
            if (cam.url || cam.entity) return [{url: cam.url, entity: cam.entity}];
            return [];
        }

        _setStreams(cam, list) {
            cam.streams = list;
            delete cam.url;
            delete cam.entity;
        }

        _fire() {
            this.dispatchEvent(new CustomEvent('config-changed', {
                detail: {config: clone(this._config)},
                bubbles: true,
                composed: true,
            }));
        }

        _prepForm(form, schema) {
            form.schema = schema;
            form.hass = this._hass;
            form.computeLabel = s => trOr('label.' + s.name, s.name);
            form.computeHelper = s => s.disabled ? trOr('help.' + s.name + (s.reason === 'bg' ? '_off_bg' : '_off'), trOr('help.' + s.name, '')) : trOr('help.' + s.name, '');
        }

        /** Skriver felter til konfigurationen. Kun værdier, der afviger fra standarden, kommer i YAML. */
        _setFields(v) {
            const c = this._config;
            Object.keys(v).forEach(key => {
                if (!(key in FIELD_DEF)) return;
                let val = v[key];
                if (typeof val === 'string') val = val.trim();
                if ((key === 'accent_color_custom' || key === 'cam_label_color_custom') && Array.isArray(val)) val = toHex(val);
                if (key === 'grid_columns') val = val === 'auto' || !val ? undefined : parseInt(val, 10);
                if (key === 'carousel_interval') val = parseInt(val, 10) || 10;
                if (key === 'switch_effect') FIELD_DEF.switch_effect = fxDefault(v.layout || c.layout);
                const same = Array.isArray(val) ? Array.isArray(FIELD_DEF[key]) && val.length === FIELD_DEF[key].length && val.every(x => FIELD_DEF[key].includes(x)) : val === FIELD_DEF[key];
                if (val === undefined || val === '' || same) delete c[key];
                else c[key] = val;
            });
            if (c.accent_color !== 'custom') delete c.accent_color_custom;
            if (c.cam_label_color !== 'custom') delete c.cam_label_color_custom;
            // Ældre navne for de samme indstillinger
            if (c.digital_zoom !== false && c.digital_ptz === false && v.digital_zoom) delete c.digital_ptz;
            if (c.pause_offscreen !== false && c.intersection === 0 && v.pause_offscreen) delete c.intersection;
        }

        /** Værdier til en formular ud fra konfigurationen. */
        _fieldData(keys) {
            const c = this._config;
            const out = {};
            keys.forEach(k => {
                let val;
                if (k === 'ui') val = this._uiMode();
                else if (k === 'digital_zoom') val = c.digital_zoom !== false && c.digital_ptz !== false;
                else if (k === 'pause_offscreen') val = c.pause_offscreen !== false && c.intersection !== 0;
                else if (k === 'grid_columns') val = c.grid_columns ? String(c.grid_columns) : 'auto';
                else if (k === 'carousel_interval') val = String(c.carousel_interval || 10);
                else if (k === 'switch_effect') val = c.switch_effect || fxDefault(c.layout);
                else if (k === 'cam_label_pos' || k === 'cam_label_pos_small' || k === 'cam_label_pos_fs') val = clPos(c, k);
                else if (k === 'cam_label_color_custom') val = parseRgb(c.cam_label_color_custom) || [255, 255, 255];
                else if (k === 'accent_color_custom') val = parseRgb(c.accent_color_custom) || [79, 216, 255];
                else val = c[k] === undefined ? (Array.isArray(FIELD_DEF[k]) ? FIELD_DEF[k].slice() : FIELD_DEF[k]) : c[k];
                out[k] = val === undefined ? '' : val;
            });
            return out;
        }

        /* ---------- Opbygning (sker én gang) ---------- */

        _build() {
            this._built = true;
            const root = this.shadowRoot || this.attachShadow({mode: 'open'});
            root.innerHTML = `
                <style>${EDITOR_CSS}</style>
                <div class="tabs" role="tablist">
                    ${TABS.map(t => `<button class="tab" type="button" role="tab" data-tab="${t.id}">
                        <ha-icon icon="${t.icon}"></ha-icon><span class="tl">${tr('tab.' + t.id)}</span></button>`).join('')}
                </div>
                <div class="panel" data-panel="cams">
                    <div id="cams"></div>
                    <button class="btn" id="addcam" type="button">${tr('ed.add_camera')}</button>
                </div>
                <div class="panel" data-panel="layout">
                    <ha-form id="f-layout"></ha-form>
                    <div class="note" id="layoutnote" hidden>${tr('ed.layout_note')}</div>
                </div>
                <div class="panel" data-panel="intro"><ha-form id="f-intro"></ha-form></div>
                <div class="panel" data-panel="look"><ha-form id="f-look"></ha-form></div>
                <div class="panel" data-panel="panel"><ha-form id="f-panel"></ha-form><div class="note">${tr('ed.panel_note')}</div></div>
                <div class="panel" data-panel="controls"><ha-form id="f-controls"></ha-form></div>
                <div class="panel" data-panel="adv"><ha-form id="f-adv"></ha-form></div>`;

            root.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => this._setTab(b.dataset.tab)));

            const schemas = {layout: layoutSchema(1, 'auto'), intro: introSchema('focus'), look: lookSchema('primary', false), panel: PANEL_SCHEMA(), controls: CONTROLS_SCHEMA('own'), adv: ADV_SCHEMA()};
            Object.keys(schemas).forEach(id => {
                const form = root.getElementById('f-' + id);
                this._prepForm(form, schemas[id]);
                form.addEventListener('value-changed', ev => {
                    ev.stopPropagation();
                    this._setFields(ev.detail.value);
                    this._fire();
                    if (id === 'layout' || id === 'intro' || id === 'look' || id === 'controls' || id === 'adv') this._syncForm(id);
                    if (id === 'layout') this._syncForm('adv');   // layout og karrusel afgør, hvilke pause-valg der er tilgængelige
                });
            });

            root.getElementById('addcam').addEventListener('click', () => {
                const cams = this._config.cameras;
                cams.push({name: tr('camera_n', cams.length + 1), streams: [{name: 'HD', url: ''}]});
                this._open = cams.length - 1;
                this._fire();
                this._sync();
            });

            this._setTab(this._tab);
        }

        _setTab(id) {
            this._tab = id;
            const root = this.shadowRoot;
            root.querySelectorAll('.tab').forEach(b => {
                const on = b.dataset.tab === id;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            root.querySelectorAll('.panel').forEach(p => {
                p.hidden = p.dataset.panel !== id;
            });
        }

        /* ---------- Kameraer (ét foldes ud ad gangen) ---------- */

        _camBlock(ci) {
            const block = document.createElement('div');
            block.className = 'cam';
            block.innerHTML = `
                <button class="cam-head" type="button">
                    <ha-icon class="ci" icon="mdi:cctv"></ha-icon>
                    <span class="cn"></span>
                    <span class="badges"></span>
                    <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
                </button>
                <div class="cam-body" hidden>
                    <ha-form class="name"></ha-form>
                    <div class="subh">${tr('ed.streams')}</div>
                    <div class="streams"></div>
                    <button class="btn add" type="button">${tr('ed.add_stream')}</button>
                    <div class="subh">${tr('ed.ptz_head')}</div>
                    <ha-form class="ptz"></ha-form>
                    <div class="note ptznote" hidden>${tr('ed.ptz_note')}</div>
                    <div class="subh">${tr('ed.ctl_head')}</div>
                    <ha-form class="ctl"></ha-form>
                    <div class="note">${tr('ed.ctl_note')}</div>
                    <div class="actions">
                        <button class="btn sm up" type="button" title="${tr('ed.move_up_title')}">${tr('ed.move_up')}</button>
                        <button class="btn sm down" type="button" title="${tr('ed.move_down_title')}">${tr('ed.move_down')}</button>
                        <button class="btn sm rm" type="button">${tr('ed.remove_camera')}</button>
                    </div>
                </div>`;

            const q = sel => block.querySelector(sel);
            const cams = () => this._config.cameras;

            q('.cam-head').addEventListener('click', () => {
                this._open = this._open === ci ? -1 : ci;
                this._applyOpen();
            });

            const name = q('.name');
            this._prepForm(name, CAM_SCHEMA);
            name.addEventListener('value-changed', ev => {
                ev.stopPropagation();
                const v = (ev.detail.value.name || '').trim();
                if (v) cams()[ci].name = v;
                else delete cams()[ci].name;
                const lb = (ev.detail.value.label || '').trim();
                if (lb) cams()[ci].label = lb.slice(0, 24);
                else delete cams()[ci].label;
                this._fire();
                this._syncHead(ci);
            });

            const ptz = q('.ptz');
            this._prepForm(ptz, PTZ_TOGGLE);
            ptz.addEventListener('value-changed', ev => {
                ev.stopPropagation();
                this._onPtz(ci, ev.detail.value);
            });

            const ctl = q('.ctl');
            this._prepForm(ctl, CTL_SCHEMA);
            ctl.addEventListener('value-changed', ev => {
                ev.stopPropagation();
                this._onCtl(ci, ev.detail.value);
            });

            q('.add').addEventListener('click', () => {
                const cam = cams()[ci];
                const list = this._streams(cam);
                list.push({name: list.length === 0 ? 'HD' : list.length === 1 ? 'SD' : '', url: ''});
                this._setStreams(cam, list);
                this._fire();
                this._sync();
            });

            const move = dir => {
                const list = cams();
                const j = ci + dir;
                if (j < 0 || j >= list.length) return;
                [list[ci], list[j]] = [list[j], list[ci]];
                this._open = j;
                this._fire();
                this._sync();
            };
            q('.up').addEventListener('click', () => move(-1));
            q('.down').addEventListener('click', () => move(1));
            q('.rm').addEventListener('click', () => {
                if (cams().length < 2) return;
                cams().splice(ci, 1);
                this._open = Math.min(ci, cams().length - 1);
                this._fire();
                this._sync();
            });

            return block;
        }

        _applyOpen() {
            const box = this.shadowRoot.getElementById('cams');
            Array.from(box.children).forEach((block, i) => {
                const open = i === this._open;
                block.classList.toggle('open', open);
                block.querySelector('.cam-body').hidden = !open;
                block.querySelector('.cam-head').setAttribute('aria-expanded', open ? 'true' : 'false');
            });
        }

        /** Navn og små mærker på kameraets overskrift. */
        _syncHead(ci) {
            const cam = this._config.cameras[ci];
            const block = this.shadowRoot.getElementById('cams').children[ci];
            const streams = this._streams(cam);
            const ptz = !!cam.ptz && cam.ptz.enabled !== false;
            block.querySelector('.cn').textContent = cam.name || tr('camera_n', ci + 1);
            const ctl = !!cam.control && Object.keys(cam.control).some(k => cam.control[k]);
            block.querySelector('.badges').innerHTML =
                `<span>${streams.length ? streams.map((s, i) => s.name || `S${i}`).join(' · ') : 'ingen stream'}</span>` +
                (ptz ? '<ha-icon icon="mdi:arrow-all" title="PTZ"></ha-icon>' : '') +
                (ctl ? '<ha-icon icon="mdi:tune-variant" title="' + tr('ed.controls_badge') + '"></ha-icon>' : '');
        }

        /* ---------- Opdatering af felterne ---------- */

        _sync() {
            const root = this.shadowRoot;
            const c = this._config;

            const box = root.getElementById('cams');
            if (box.children.length !== c.cameras.length) {
                box.innerHTML = '';
                c.cameras.forEach((cam, i) => box.appendChild(this._camBlock(i)));
            }
            if (this._open >= c.cameras.length) this._open = c.cameras.length - 1;
            c.cameras.forEach((cam, i) => this._syncCam(i));
            this._applyOpen();

            Object.keys(TAB_FIELDS).forEach(id => this._syncForm(id));

            root.querySelector('.tab[data-tab="cams"] .tl').textContent = tr('ed.tab_cams_n', c.cameras.length);
            root.getElementById('layoutnote').hidden = c.cameras.length > 1;
        }

        /** Sætter værdierne i en fane og skifter skema, når felterne afhænger af valget. */
        _syncForm(id) {
            const c = this._config;
            const form = this.shadowRoot.getElementById('f-' + id);

            if (id === 'layout') {
                const layout = c.layout || 'auto';
                const key = `${c.cameras.length > 1}|${layout}|${c.carousel === true}|${c.fullscreen_nav !== false}`;
                if (key !== this._layoutKey) {
                    this._layoutKey = key;
                    form.schema = layoutSchema(c.cameras.length, layout, c.carousel === true, c.fullscreen_nav !== false);
                }
            } else if (id === 'intro') {
                const key = `${(c.intro || 'focus') === 'none'}`;
                if (key !== this._introKey) {
                    this._introKey = key;
                    form.schema = introSchema(c.intro || 'focus');
                }
            } else if (id === 'look') {
                const color = c.accent_color || 'primary';
                const key = `${color === 'custom'}|${c.cam_label === true}|${c.cam_label_color === 'custom'}|${c.cam_label_readout === true}`;
                if (key !== this._lookKey) {
                    this._lookKey = key;
                    form.schema = lookSchema(color, c.cam_label === true, c.cam_label_color, c.cam_label_readout === true);
                }
            } else if (id === 'adv') {
                const multi = c.cameras.length > 1 && c.layout !== 'single';
                const blocked = multi && c.layout !== 'grid' && c.carousel === true && c.fullscreen_carousel !== false;
                const bg = c.background === true;
                const key = `${multi}|${blocked}|${bg}`;
                if (key !== this._advKey) {
                    this._advKey = key;
                    form.schema = ADV_SCHEMA(multi, blocked, bg);
                }
            } else if (id === 'controls') {
                const mode = this._uiMode();
                if (mode !== this._ctlKey) {
                    this._ctlKey = mode;
                    form.schema = CONTROLS_SCHEMA(mode);
                }
            }
            form.data = this._fieldData(TAB_FIELDS[id]);
        }

        /** Hvordan knapper på billedet er sat: own (kortets egne), browser (browserens) eller none. */
        _uiMode() {
            const u = this._config.ui;
            return u === false || u === 'browser' ? 'browser' : u === 'none' ? 'none' : 'own';
        }

        _syncCam(ci) {
            const cams = this._config.cameras;
            const cam = cams[ci];
            const block = this.shadowRoot.getElementById('cams').children[ci];
            const q = sel => block.querySelector(sel);

            this._syncHead(ci);
            q('.up').disabled = ci === 0;
            q('.down').disabled = ci === cams.length - 1;
            q('.rm').hidden = cams.length < 2;
            q('.name').data = {name: cam.name || '', label: cam.label || ''};

            const list = this._streams(cam);
            const box = q('.streams');
            // Rækkerne bygges kun om, når antallet ændres (ellers mister tekstfelterne fokus)
            if (box.children.length !== list.length) {
                box.innerHTML = '';
                list.forEach((s, si) => box.appendChild(this._streamRow(ci, si)));
            }
            list.forEach((s, si) => {
                const form = box.children[si].querySelector('ha-form');
                form.data = {name: s.name || '', url: s.url || '', mode: s.mode || 'auto'};
                form.hass = this._hass;
            });

            this._syncPtz(ci);
            const ctlForm = q('.ctl');
            ctlForm.data = Object.assign({privacy: '', preset: '', patrol: '', patrol_mode: '', light: ''}, cam.control || {});
            ctlForm.hass = this._hass;
        }

        _streamRow(ci, si) {
            const row = document.createElement('div');
            row.className = 'row';

            const form = document.createElement('ha-form');
            this._prepForm(form, STREAM_SCHEMA());
            form.addEventListener('value-changed', ev => {
                ev.stopPropagation();
                this._onStream(ci, si, ev.detail.value);
            });

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'btn del';
            del.textContent = tr('ed.remove_stream');
            del.addEventListener('click', () => {
                const cam = this._config.cameras[ci];
                const list = this._streams(cam);
                list.splice(si, 1);
                this._setStreams(cam, list);
                this._fire();
                this._sync();
            });

            row.append(form, del);
            return row;
        }

        _onStream(ci, si, v) {
            const cam = this._config.cameras[ci];
            const list = this._streams(cam);
            const s = Object.assign({}, list[si]);

            if (v.name) s.name = v.name;
            else delete s.name;

            s.url = v.url || '';

            if (v.mode && v.mode !== 'auto') s.mode = v.mode;
            else delete s.mode;

            list[si] = s;
            this._setStreams(cam, list);
            this._fire();
            this._syncHead(ci);
        }

        /* ---------- Kamerastyring (pr. kamera) ---------- */

        _onCtl(ci, v) {
            const cam = this._config.cameras[ci];
            const prev = Object.assign({}, cam.control || {});
            const vals = {};
            ['privacy', 'preset', 'patrol', 'patrol_mode', 'light'].forEach(k => {
                vals[k] = v[k] || '';
            });

            // Forslag: udfyld de andre ud fra navnemønstret på den entitet, der lige er valgt
            const changed = Object.keys(vals).find(k => vals[k] && vals[k] !== prev[k]);
            const m = changed && vals[changed].match(/^[a-z_]+\.(.+?)_(privacy|move_to_preset|preset_patrol_mode|patrol_mode|floodlight_timed|floodlight|move_(?:left|right|up|down))$/);
            if (m && this._hass) {
                const st = this._hass.states;
                const guess = {
                    privacy: [`switch.${m[1]}_privacy`],
                    preset: [`select.${m[1]}_move_to_preset`],
                    patrol: [`switch.${m[1]}_preset_patrol_mode`],
                    patrol_mode: [`select.${m[1]}_patrol_mode`],
                    light: [`light.${m[1]}_floodlight_timed`, `light.${m[1]}_floodlight`],
                };
                Object.keys(guess).forEach(k => {
                    if (vals[k]) return;
                    const hit = guess[k].find(id => st[id]);
                    if (hit) vals[k] = hit;
                });
            }

            const out = {};
            Object.keys(vals).forEach(k => {
                if (vals[k]) out[k] = vals[k];
            });
            if (Object.keys(out).length) cam.control = out;
            else delete cam.control;

            this._fire();
            this._syncHead(ci);
            this.shadowRoot.getElementById('cams').children[ci].querySelector('.ctl').data = Object.assign({privacy: '', preset: '', patrol: '', patrol_mode: '', light: ''}, out);
        }

        /* ---------- PTZ (pr. kamera) ---------- */

        _ptzIsButton(cam) {
            const ptz = cam.ptz;
            return !ptz || !ptz.service || ptz.service === 'button.press';
        }

        _ptzEntities(cam) {
            const ptz = cam.ptz || {};
            const out = {};
            DIRS.forEach(d => {
                out[d] = (ptz['data_' + d] && ptz['data_' + d].entity_id) || '';
            });
            return out;
        }

        _syncPtz(ci) {
            const cam = this._config.cameras[ci];
            const block = this.shadowRoot.getElementById('cams').children[ci];
            const form = block.querySelector('.ptz');
            const ptz = cam.ptz;
            const enabled = !!ptz && ptz.enabled !== false;
            const button = this._ptzIsButton(cam);

            block.querySelector('.ptznote').hidden = !(enabled && !button);
            form.schema = enabled && button ? PTZ_TOGGLE.concat(PTZ_FIELDS) : PTZ_TOGGLE;
            form.data = Object.assign({enabled}, this._ptzEntities(cam));
        }

        _onPtz(ci, v) {
            const cam = this._config.cameras[ci];
            let ptz = cam.ptz;

            if (v.enabled && !ptz) ptz = cam.ptz = {service: 'button.press'};

            if (ptz) {
                if (v.enabled) delete ptz.enabled;
                else ptz.enabled = false;

                if (v.enabled && this._ptzIsButton(cam)) {
                    if (!ptz.service) ptz.service = 'button.press';

                    const prev = this._ptzEntities(cam);
                    const vals = {};
                    DIRS.forEach(d => {
                        vals[d] = v[d] || '';
                    });

                    // Forslag: udfyld de andre retninger ud fra navnemønstret ..._move_left/right/up/down
                    const changed = DIRS.find(d => vals[d] && vals[d] !== prev[d]);
                    const m = changed && vals[changed].match(/^(.+)_move_(left|right|up|down)$/);
                    if (m && this._hass) {
                        DIRS.forEach(d => {
                            const guess = `${m[1]}_move_${d}`;
                            if (!vals[d] && this._hass.states[guess]) vals[d] = guess;
                        });
                    }

                    DIRS.forEach(d => {
                        if (vals[d]) ptz['data_' + d] = {entity_id: vals[d]};
                        else delete ptz['data_' + d];
                    });
                }
            }

            this._fire();
            this._syncPtz(ci);
            this._syncHead(ci);
        }
    }

    /* ======================================================================
     * 4. REGISTRERING
     * ==================================================================== */

    if (!customElements.get('panoptes-player')) customElements.define('panoptes-player', PanoptesPlayer);
    if (!customElements.get('panoptes-card')) customElements.define('panoptes-card', PanoptesCard);
    if (!customElements.get('panoptes-card-editor')) customElements.define('panoptes-card-editor', PanoptesCardEditor);

    window.customCards = window.customCards || [];
    if (!window.customCards.some(c => c.type === 'panoptes-card')) {
        window.customCards.push({
            type: 'panoptes-card',
            name: 'Panoptes',
            preview: false,
            description: 'Camera card for go2rtc streams with HD/SD switching, PTZ and a visual editor',
        });
    }

    console.info(`%c PANOPTES-CARD %c v${VERSION} `, 'color:#fff;background:#3b6ea5;font-weight:700', 'color:#3b6ea5;background:#fff');
})();
