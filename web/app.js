// src/theme.ts
var C = {
  // text
  label: [208, 208, 208],
  // 10.72:1
  muted: [138, 138, 138],
  // 4.79:1 — secondary text you actually read
  faint: [110, 118, 129],
  // chrome that only has to be visible
  rule: [95, 95, 95],
  gold: [255, 214, 92],
  night: [26, 28, 40],
  selBg: [48, 54, 78],
  // gauge
  track: [68, 68, 68],
  fillOk: [95, 175, 95],
  // 6.13:1
  fillWarn: [215, 175, 95],
  // 8.02:1
  fillHot: [255, 95, 95],
  // 5.55:1
  // office interior
  floor: [72, 68, 88],
  floorAlt: [66, 62, 82],
  floorDark: [40, 38, 52],
  wallStone: [96, 92, 118],
  wallLip: [128, 122, 152],
  deskTop: [138, 96, 62],
  deskEdge: [104, 70, 44],
  deskPaper: [232, 228, 214],
  monitorCase: [40, 42, 54],
  screenOn: [120, 226, 200],
  // screen tint by what the session is doing, readable across the whole room
  screenEdit: [120, 170, 255],
  screenRead: [110, 220, 235],
  screenRun: [250, 180, 90],
  screenSearch: [200, 160, 250],
  screenAgent: [160, 235, 150],
  screenOff: [58, 62, 78],
  counter: [188, 176, 152],
  counterEdge: [140, 128, 108],
  tableTop: [96, 132, 108],
  tableEdge: [64, 96, 76],
  couch: [122, 108, 156],
  couchEdge: [88, 76, 116],
  // town (kept for the older renderer)
  grass: [104, 176, 96],
  grassDk: [80, 152, 80],
  grassLt: [128, 196, 112],
  path: [232, 208, 152],
  pathDk: [212, 184, 128],
  pathEdge: [166, 128, 84],
  wall: [246, 236, 208],
  wallSh: [214, 200, 172],
  door: [150, 98, 62],
  doorDk: [110, 70, 44],
  window: [126, 196, 236],
  windowFrame: [250, 250, 250],
  tree: [56, 128, 64],
  treeDk: [38, 96, 50],
  trunk: [110, 78, 48],
  sign: [186, 140, 88],
  signPost: [128, 92, 56],
  paper: [252, 250, 244],
  ink: [32, 34, 46]
};
var TIERS = [
  { min: 1, color: [150, 158, 185], name: "new" },
  { min: 5, color: [130, 190, 140], name: "steady" },
  { min: 8, color: [110, 200, 190], name: "seasoned" },
  { min: 11, color: [110, 200, 240], name: "skilled" },
  { min: 15, color: [120, 170, 250], name: "veteran" },
  { min: 20, color: [165, 150, 250], name: "expert" },
  { min: 27, color: [215, 140, 235], name: "elder" },
  { min: 37, color: [250, 150, 160], name: "master" },
  { min: 50, color: [255, 180, 100], name: "legend" },
  { min: 68, color: [255, 225, 130], name: "mythic" }
];
var tierOf = (level) => TIERS.filter((t) => level >= t.min).pop() ?? TIERS[0];
var LOOK = {
  error: { glyph: "\u2717", label: "error", color: [255, 95, 95] },
  review: { glyph: "\u25C6", label: "unread", color: [140, 210, 255] },
  needs: { glyph: "\u25B2", label: "needs you", color: [255, 176, 60] },
  // amber is reserved for "your turn" everywhere else in the Claude tooling, so
  // working takes the cool colour its own lit screen already uses
  working: { glyph: "\u25CF", label: "working", color: [120, 226, 200] },
  shell: { glyph: "\u25CD", label: "shell", color: [95, 175, 215] },
  // healthy and finished: deliberately cool and quiet, not green
  done: { glyph: "\u25CB", label: "your turn", color: [135, 206, 250] },
  parked: { glyph: "\xB7", label: "parked", color: [138, 138, 138] }
};
var ROOFS = [
  [228, 96, 92],
  [240, 148, 64],
  [236, 200, 84],
  [176, 208, 88],
  [112, 200, 112],
  [96, 206, 176],
  [96, 190, 228],
  [110, 150, 238],
  [152, 130, 236],
  [200, 124, 224],
  [236, 120, 176],
  [196, 152, 116]
];
function projectColours(names) {
  const out = /* @__PURE__ */ new Map();
  [...new Set(names)].sort().forEach((name, i) => out.set(name, ROOFS[i % ROOFS.length]));
  return out;
}
var R = "\x1B[0m";

// web/dom.ts
var $ = (sel) => document.querySelector(sel);
var rgb = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
var ago = (ms) => {
  const m = Math.round(ms / 6e4);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

// src/data/select.ts
function needsAttention(s) {
  if (s.state === "needs") return s.waitingFor ?? "blocked";
  if (s.ctxUsed / s.ctxLimit > 0.9) return "context almost full";
  return null;
}
function order(list) {
  return [...list].sort((a, b) => {
    const at = needsAttention(a) ? 0 : 1;
    const bt = needsAttention(b) ? 0 : 1;
    if (at !== bt) return at - bt;
    if (a.stale !== b.stale) return b.stale - a.stale;
    return a.id.localeCompare(b.id);
  });
}

// src/contrast.ts
var lin = (c) => c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
var luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function contrast(a, b) {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
}
var mix = (a, p, b) => [0, 1, 2].map((i) => Math.round(a[i] * p + b[i] * (1 - p)));
var WHITE = [255, 255, 255];
var BLACK = [0, 0, 0];
function readable(fg, bg, target = 4.5) {
  if (contrast(fg, bg) >= target) return fg;
  const toward = luminance(bg) < 0.5 ? WHITE : BLACK;
  if (contrast(toward, bg) < target) return toward;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const m = (lo + hi) / 2;
    if (contrast(mix(toward, m, fg), bg) >= target) hi = m;
    else lo = m;
  }
  return mix(toward, hi, fg);
}

// web/list.ts
var CRT = `<svg viewBox="0 0 16 14" width="26" height="23" shape-rendering="crispEdges" aria-hidden="true" fill="currentColor">
	<rect x="0" y="0" width="16" height="11" opacity=".55"/>
	<rect x="1" y="1" width="14" height="9" fill="#0d0c12"/>
	<rect x="3" y="4" width="1" height="1"/><rect x="4" y="5" width="1" height="1"/><rect x="3" y="6" width="1" height="1"/>
	<rect x="6" y="4" width="2" height="3"/>
	<rect x="6" y="11" width="4" height="2" opacity=".55"/>
	<rect x="3" y="13" width="10" height="1"/>
</svg>`;
var WEIGHT = {
  error: 0.26,
  needs: 0.22,
  working: 0.16,
  shell: 0.16,
  review: 0.11,
  done: 0.07,
  parked: 0.03
};
var tintOf = (state) => `${(WEIGHT[state] ?? 0.1) * 100}%`;
var BG = [25, 23, 34];
var PANEL = [34, 31, 46];
var FAINT = [129, 136, 146];
var MUTED = [138, 138, 138];
var cardOf = (state) => mix(LOOK[state].color, WEIGHT[state] ?? 0.1, PANEL);
var bandOf = (state) => mix(LOOK[state].color, WEIGHT[state] ?? 0.1, BG);
var BANDS = [
  { key: "error", label: "failed", has: (s) => s.state === "error" },
  { key: "needs", label: "needs you", has: (s) => s.state === "needs" },
  {
    key: "live",
    label: "working",
    has: (s) => s.state === "working" || s.state === "shell"
  },
  {
    key: "review",
    label: "finished, unread",
    has: (s) => s.state === "review"
  },
  { key: "done", label: "your turn", has: (s) => s.state === "done" },
  { key: "parked", label: "parked", has: (s) => s.state === "parked" }
];
var opened = /* @__PURE__ */ new Set();
var tokens = (n) => n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
var listEl;
var emptyEl;
var onTerminal = null;
var current = [];
function mountList(list, empty, terminal) {
  listEl = list;
  emptyEl = empty;
  onTerminal = terminal ?? null;
}
function details(s) {
  const dl = document.createElement("dl");
  dl.className = "[grid-area:detail] mt-2.5 grid [grid-template-columns:max-content_1fr] gap-x-3.5 gap-y-1 border-t border-line pt-2.5 text-[0.82rem]";
  const rows = [
    ["title", s.title || "\u2014"],
    ["folder", s.cwd],
    ["level", `${s.level} ${tierOf(s.level).name} \xB7 ${tokens(s.xp)} xp`],
    ["turns", String(s.turns)],
    ["context", s.ctxUsed ? `${tokens(s.ctxUsed)} of ${tokens(s.ctxLimit)}` : "nothing yet"],
    ["idle", ago(s.stale)],
    ...s.tab ? [["tab", `\u2318${s.tab}`]] : [],
    ...s.waitingFor ? [["waiting on", s.waitingFor]] : [],
    ...s.last && s.last !== s.doing ? [["last said", s.last]] : []
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.className = "text-(--dim)";
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.className = "m-0 text-(--soft) [overflow-wrap:anywhere]";
    dd.textContent = v;
    dl.append(dt, dd);
  }
  return dl;
}
function paintList(list) {
  current = list;
  const sorted = order(list);
  const hues = projectColours(list.map((s) => s.proj));
  emptyEl.hidden = sorted.length > 0;
  const nodes = [];
  for (const band2 of BANDS) {
    const members = sorted.filter(band2.has);
    if (!members.length) continue;
    const head = document.createElement("li");
    head.className = "band band-rule tint-page sticky top-12 z-[1] mt-3.5 mb-px flex items-center gap-2.5 rounded border-l-5 border-(--state) px-2.5 py-1.5 text-[0.76rem] font-bold tracking-[0.14em] text-(--ink) uppercase first:mt-0";
    const key = members[0].state;
    head.style.setProperty("--state", rgb(LOOK[key].color));
    head.style.setProperty("--ink", rgb(readable(LOOK[key].color, bandOf(key))));
    head.style.setProperty("--tint", tintOf(band2.key));
    head.innerHTML = `<span></span><span class="rounded-full bg-(--state) px-1.5 py-px font-bold text-[#1a1c28]"></span>`;
    head.children[0].textContent = band2.label;
    head.children[1].textContent = String(members.length);
    nodes.push(head);
    nodes.push(...members.map(row));
  }
  listEl.replaceChildren(...nodes);
  function row(s) {
    const look = LOOK[s.state];
    const li = document.createElement("li");
    const busy = s.state === "working" || s.state === "shell";
    const attn = needsAttention(s);
    li.className = [
      "row group grid cursor-pointer gap-x-2.5 gap-y-0.5 rounded-md border border-l-5 border-(--state) p-2.5 tint-panel",
      '[grid-template-columns:auto_1fr_auto_auto] [grid-template-areas:"lv_proj_meta_term""lv_doing_doing_term""detail_detail_detail_detail"]',
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--state)",
      attn ? "attn" : "border-state-soft",
      busy ? "sweep" : ""
    ].join(" ");
    if (busy) li.style.setProperty("--phase", `-${Date.now() % 1600}ms`);
    const card = cardOf(s.state);
    li.style.setProperty("--state", rgb(look.color));
    li.style.setProperty("--ink", rgb(readable(look.color, card)));
    li.style.setProperty("--hot", rgb(readable([255, 95, 95], card)));
    li.style.setProperty("--dim", rgb(readable(FAINT, card)));
    li.style.setProperty("--soft", rgb(readable(MUTED, card, 5.5)));
    li.style.setProperty("--tint", tintOf(s.state));
    li.style.setProperty("--tier", rgb(tierOf(s.level).color));
    li.style.setProperty("--proj", rgb(readable(hues.get(s.proj) ?? look.color, card)));
    const pct = s.ctxLimit ? Math.round(s.ctxUsed / s.ctxLimit * 100) : 0;
    li.innerHTML = `
			<span class="[grid-area:lv] self-center min-w-[2.1rem] rounded px-1.5 py-0.5 text-center text-[0.8rem] font-bold text-[#1a1c28] bg-(--tier)">${s.level}</span>
			<span class="[grid-area:proj] flex min-w-0 items-baseline gap-1.5 after:inline-block after:text-faint after:transition-transform after:duration-150 after:content-['\u203A'] group-[.open]:after:rotate-90">
				<span class="proj truncate font-bold text-(--proj)"></span>
				<span class="away hidden shrink-0 text-[0.78rem] font-normal text-muted"></span>
			</span>
			<span class="[grid-area:meta] flex items-center gap-2.5 text-[0.78rem] whitespace-nowrap text-(--dim)">
				<span class="text-(--ink)">${look.glyph} ${look.label}</span>
				${s.ctxUsed ? `<span class="tabular-nums${pct > 90 ? " text-(--hot)" : ""}">${pct}%</span>` : ""}
				<span>${ago(s.stale)}</span>
			</span>
			<span class="doing [grid-area:doing] truncate text-[0.86rem] ${attn ? "text-label" : "text-(--soft)"}"></span>`;
    li.querySelector(".proj").textContent = s.proj;
    const away = li.querySelector(".away");
    if (s.away) {
      away.textContent = `\u2192 ${s.away}`;
      away.title = `Started in ${s.proj}, currently working in ${s.away}`;
      away.classList.remove("hidden");
    }
    li.querySelector(".doing").textContent = s.doing || s.last || "\u2014";
    if (s.workspace) {
      const term = document.createElement("button");
      term.type = "button";
      term.title = `Open ${s.proj}'s terminal`;
      term.className = "[grid-area:term] flex h-9 w-11 cursor-pointer items-center justify-center self-center rounded bg-transparent text-ok hover:text-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";
      term.innerHTML = CRT;
      term.addEventListener("click", (e) => {
        e.stopPropagation();
        onTerminal?.(s.id, s.proj);
      });
      li.append(term);
    }
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    const open2 = opened.has(s.id);
    li.setAttribute("aria-expanded", String(open2));
    if (open2) {
      li.classList.add("open");
      li.append(details(s));
    }
    const toggle = () => {
      if (opened.has(s.id)) opened.delete(s.id);
      else opened.add(s.id);
      paintList(current);
    };
    li.addEventListener("click", toggle);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    return li;
  }
}

// src/canvas.ts
var Canvas = class {
  w;
  h;
  rows;
  px;
  overlay;
  constructor(w, h) {
    this.w = w;
    this.h = h + h % 2;
    this.rows = this.h / 2;
    this.px = new Int32Array(this.w * this.h);
    this.overlay = Array.from({ length: this.rows }, () => new Array(this.w).fill(null));
  }
  clear(c) {
    this.px.fill(c ? c[0] << 16 | c[1] << 8 | c[2] : -1);
    for (const r of this.overlay) r.fill(null);
  }
  set(x, y, c) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = c[0] << 16 | c[1] << 8 | c[2];
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const v = this.px[y * this.w + x];
    return v < 0 ? null : [v >> 16 & 255, v >> 8 & 255, v & 255];
  }
  /**
   * The packed pixels, for a caller that walks all of them.
   *
   * `get()` allocates a three-element array per pixel, which is the right shape for
   * reading one and the wrong shape for reading ten thousand: the room's floor loop
   * did exactly that every frame and spent 12.75ms of a 16.7ms budget on it, most
   * of it in allocation. Bulk readers take the ints and unpack them themselves —
   * `0xRRGGBB`, negative meaning transparent.
   */
  pixels() {
    return this.px;
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** Blend a colour over what is already there — used for zone carpets. */
  tint(x, y, w, h, c, amount) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const base = this.get(x + i, y + j);
        if (!base) continue;
        this.set(x + i, y + j, [
          base[0] + (c[0] - base[0]) * amount,
          base[1] + (c[1] - base[1]) * amount,
          base[2] + (c[2] - base[2]) * amount
        ]);
      }
    }
  }
  outline(x, y, w, h, c) {
    for (let i = 0; i < w; i++) {
      this.set(x + i, y, c);
      this.set(x + i, y + h - 1, c);
    }
    for (let j = 0; j < h; j++) {
      this.set(x, y + j, c);
      this.set(x + w - 1, y + j, c);
    }
  }
  blit(x, y, sp) {
    for (let j = 0; j < sp.h; j++)
      for (let i = 0; i < sp.w; i++) {
        const c = sp.grid[j][i];
        if (c) this.set(x + i, y + j, c);
      }
  }
  /** The text cell at a position, if one was written there.
   *
   *  Needed by the documentation renderer, which composites the pixel layer as a
   *  raster and re-draws these as real glyphs on top — a nameplate flattened into
   *  half blocks is unreadable at any size. */
  cellAt(col, row) {
    return this.overlay[row]?.[col] ?? null;
  }
  text(col, row, s, f, b, bold = false) {
    if (row < 0 || row >= this.rows) return;
    for (const [i, ch] of [...s].entries()) {
      const c = col + i;
      if (c < 0 || c >= this.w) continue;
      this.overlay[row][c] = { ch, fg: f, bg: b, bold };
    }
  }
  render() {
    const lines = [];
    for (let r = 0; r < this.rows; r++) {
      let out = "";
      let cf = -2;
      let cb = -2;
      let cbold = false;
      const ov = this.overlay[r];
      const t0 = r * 2 * this.w;
      const b0 = (r * 2 + 1) * this.w;
      for (let x = 0; x < this.w; x++) {
        const o = ov[x];
        let top;
        let bot;
        let ch;
        if (o) {
          top = o.fg ? o.fg[0] << 16 | o.fg[1] << 8 | o.fg[2] : -1;
          bot = o.bg ? o.bg[0] << 16 | o.bg[1] << 8 | o.bg[2] : -1;
          ch = o.ch;
        } else {
          top = this.px[t0 + x];
          bot = this.px[b0 + x];
          ch = top < 0 && bot < 0 ? " " : "\u2580";
        }
        if (top !== cf) {
          out += top < 0 ? "\x1B[39m" : `\x1B[38;2;${top >> 16 & 255};${top >> 8 & 255};${top & 255}m`;
          cf = top;
        }
        if (bot !== cb) {
          out += bot < 0 ? "\x1B[49m" : `\x1B[48;2;${bot >> 16 & 255};${bot >> 8 & 255};${bot & 255}m`;
          cb = bot;
        }
        const wantBold = !!o?.bold;
        if (wantBold !== cbold) {
          out += wantBold ? "\x1B[1m" : "\x1B[22m";
          cbold = wantBold;
        }
        out += ch;
      }
      lines.push(out + R);
    }
    return lines;
  }
};

// src/data/types.ts
var RANK = { error: 0, needs: 1, working: 2, shell: 3, review: 4, done: 5, parked: 6 };

// src/data/describe.ts
var cut = (s, n) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, Math.max(0, n - 1)).join("") + "\u2026" : t;
};

// src/props.ts
var U = 16;
var P = {
  wood: [146, 104, 66],
  woodDk: [104, 72, 44],
  woodLt: [178, 134, 90],
  counter: [206, 198, 182],
  counterDk: [150, 142, 128],
  steel: [176, 184, 196],
  steelDk: [120, 128, 142],
  felt: [58, 132, 96],
  feltDk: [40, 100, 72],
  white: [244, 246, 250],
  fabric: [126, 112, 168],
  fabricDk: [92, 80, 130],
  fabricLt: [156, 142, 198],
  leaf: [78, 156, 92],
  leafDk: [52, 118, 70],
  pot: [166, 106, 78],
  potDk: [124, 76, 56],
  glass: [150, 200, 230],
  dark: [40, 42, 54],
  ink: [30, 32, 42],
  board: [236, 238, 242],
  marker: [110, 170, 220],
  book: [190, 90, 80],
  book2: [88, 132, 190],
  book3: [214, 176, 90]
};
function blank(wTiles, hTiles) {
  const w = wTiles * U;
  const h = hTiles * U;
  const grid = Array.from({ length: h }, () => new Array(w).fill(null));
  const put = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < w && y < h) grid[y][x] = c;
  };
  const box = (x, y, bw, bh, c) => {
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) put(x + i, y + j, c);
  };
  return { w, h, grid, put, box };
}
function kitchen() {
  const { w, h, grid, put, box } = blank(3, 1);
  box(0, 2, w, 12, P.counter);
  box(0, 2, w, 1, P.white);
  box(0, 13, w, 2, P.wood);
  for (let x = 0; x < w; x += 12) box(x, 13, 1, 2, P.woodDk);
  box(3, 5, 11, 7, P.steelDk);
  box(4, 6, 9, 5, P.steel);
  box(8, 3, 1, 3, P.steel);
  box(34, 3, 9, 10, P.dark);
  box(36, 5, 5, 5, [90, 60, 44]);
  box(36, 5, 5, 1, [180, 120, 84]);
  put(42, 4, [230, 90, 80]);
  box(28, 7, 3, 4, P.white);
  put(31, 8, P.white);
  return { w, h, grid };
}
function pingpong() {
  const { w, h, grid, box } = blank(2, 1);
  box(0, 2, w, 12, P.felt);
  box(0, 2, w, 1, P.white);
  box(0, 13, w, 1, P.white);
  box(14, 0, 4, 16, P.feltDk);
  box(14, 0, 4, 2, P.white);
  for (let y = 2; y < 14; y += 3) box(14, y, 4, 1, [230, 236, 240]);
  box(2, 14, 2, 2, P.steelDk);
  box(w - 4, 14, 2, 2, P.steelDk);
  return { w, h, grid };
}
function couch() {
  const { w, h, grid, box } = blank(2, 1);
  box(0, 2, w, h - 2, P.fabricDk);
  box(1, 0, w - 2, 5, P.fabric);
  box(2, 1, w - 4, 3, P.fabricLt);
  box(0, 3, 3, h - 4, P.fabric);
  box(w - 3, 3, 3, h - 4, P.fabric);
  box(4, 6, 11, 8, P.fabricLt);
  box(17, 6, 11, 8, P.fabricLt);
  box(4, 13, 11, 1, P.fabricDk);
  box(17, 13, 11, 1, P.fabricDk);
  return { w, h, grid };
}
function lowtable() {
  const { w, h, grid, box, put } = blank(2, 1);
  box(2, 4, w - 4, 8, P.wood);
  box(2, 4, w - 4, 1, P.woodLt);
  box(2, 11, w - 4, 1, P.woodDk);
  box(4, 12, 2, 3, P.woodDk);
  box(w - 6, 12, 2, 3, P.woodDk);
  box(8, 6, 6, 3, P.white);
  box(20, 5, 3, 4, P.glass);
  put(21, 4, P.white);
  return { w, h, grid };
}
function plant() {
  const { grid, box, put } = blank(1, 1);
  box(5, 10, 6, 5, P.pot);
  box(5, 10, 6, 1, P.potDk);
  box(6, 14, 4, 1, P.potDk);
  box(6, 4, 4, 6, P.leafDk);
  box(4, 2, 3, 5, P.leaf);
  box(9, 1, 3, 6, P.leaf);
  box(7, 0, 2, 4, P.leafDk);
  put(3, 5, P.leaf);
  put(12, 4, P.leaf);
  return { w: U, h: U, grid };
}
function cooler() {
  const { grid, box } = blank(1, 1);
  box(5, 1, 6, 6, P.glass);
  box(6, 2, 4, 4, [180, 220, 240]);
  box(4, 7, 8, 8, P.white);
  box(4, 7, 8, 1, P.steelDk);
  box(7, 10, 2, 2, P.steelDk);
  box(5, 14, 6, 1, P.steelDk);
  return { w: U, h: U, grid };
}
function whiteboard() {
  const { w, grid, box } = blank(2, 1);
  box(1, 2, w - 2, 11, P.board);
  box(1, 2, w - 2, 1, P.steel);
  box(1, 12, w - 2, 1, P.steelDk);
  box(4, 5, 12, 1, P.marker);
  box(4, 7, 18, 1, P.marker);
  box(4, 9, 8, 1, [230, 140, 130]);
  box(20, 9, 6, 1, P.marker);
  return { w, h: U, grid };
}
function shelf() {
  const { grid, box } = blank(1, 1);
  box(1, 1, 14, 14, P.woodDk);
  box(2, 2, 12, 5, P.wood);
  box(2, 8, 12, 6, P.wood);
  for (let i = 0; i < 4; i++) box(3 + i * 3, 2, 2, 5, [P.book, P.book2, P.book3, P.book2][i]);
  for (let i = 0; i < 4; i++) box(3 + i * 3, 8, 2, 6, [P.book3, P.book, P.book2, P.book][i]);
  return { w: U, h: U, grid };
}
var MAKERS = {
  kitchen,
  pingpong,
  couch,
  lowtable,
  plant,
  cooler,
  whiteboard,
  shelf
};
var PROP_SIZE = {
  kitchen: { w: 3, h: 1 },
  pingpong: { w: 2, h: 1 },
  couch: { w: 2, h: 1 },
  lowtable: { w: 2, h: 1 },
  plant: { w: 1, h: 1 },
  cooler: { w: 1, h: 1 },
  whiteboard: { w: 2, h: 1 },
  shelf: { w: 1, h: 1 }
};
var cache = /* @__PURE__ */ new Map();
function prop(kind) {
  const hit = cache.get(kind);
  if (hit) return hit;
  const g = MAKERS[kind]();
  cache.set(kind, g);
  return g;
}

// src/office/model.ts
var TILE = 4;
var CHAR_W = TILE;
var CHAR_H = TILE * 2;
var MON_COLS = TILE;
var MON_ROWS = TILE / 2 + 2;
var PLATE_COLS = 4;
var PLATE_ROWS = 3 * (TILE / 2);
var SIT_SINK = Math.round(CHAR_H * 6 / 32);
var WALK_TILES_PER_SEC = 3;
var TYPE_FRAME_SEC = 0.3;
var WALK_FRAME_SEC = 0.15;
var IDLE_PAUSE_MIN = 2;
var IDLE_PAUSE_MAX = 12;
var SEAT_REST_MIN = 20;
var SEAT_REST_MAX = 60;
var DONE_BUBBLE_SEC = 8;
var CHAT_RADIUS = 10;
var SCREEN_HOLD = 25e3;
var MAX_RUN = 6;
var DWELL = {
  desk: [0, 0],
  kitchen: [8, 20],
  pingpong: [30, 90],
  couch: [40, 120],
  talk: [15, 45],
  window: [10, 30]
};
var FACILITIES = {
  kitchen: {
    w: 3,
    h: 2,
    kind: "kitchen",
    spots: [
      [0, 0, "down", "stand"],
      [1, 0, "down", "stand"],
      [2, 0, "down", "stand"]
    ],
    props: [{ kind: "kitchen", dc: 0, dr: 1 }]
  },
  pingpong: {
    w: 4,
    h: 1,
    kind: "pingpong",
    spots: [
      [0, 0, "right", "stand"],
      [3, 0, "left", "stand"]
    ],
    props: [{ kind: "pingpong", dc: 1, dr: 0 }]
  },
  couch: {
    w: 2,
    h: 2,
    kind: "couch",
    spots: [
      [0, 0, "down", "sit"],
      [1, 0, "down", "sit"]
    ],
    // the couch is UNDER its occupants; a low table sits in front of it
    props: [
      { kind: "couch", dc: 0, dr: 0, under: true },
      { kind: "lowtable", dc: 0, dr: 1 }
    ]
  },
  talk: {
    w: 2,
    h: 1,
    kind: "talk",
    spots: [
      [0, 0, "right", "stand"],
      [1, 0, "left", "stand"]
    ],
    props: []
  }
};
var DROP_ORDER = ["couch", "pingpong", "kitchen"];

// src/office/plan.ts
function planRoom(cols, rows, projects) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill("floor"));
  const zoneOf = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (let c = 0; c < cols; c++) {
    grid[0][c] = "wall";
    grid[rows - 1][c] = "wall";
  }
  for (let r = 0; r < rows; r++) {
    grid[r][0] = "wall";
    grid[r][cols - 1] = "wall";
  }
  const room = {
    cols,
    rows,
    grid,
    zoneOf,
    spots: /* @__PURE__ */ new Map(),
    seatTiles: /* @__PURE__ */ new Set(),
    pods: [],
    props: [],
    walkable: [],
    workBottom: 1,
    zoneColor: /* @__PURE__ */ new Map(),
    hiddenCount: 0,
    dropped: []
  };
  room.zoneColor = projectColours(projects.map((p) => p.name));
  const bandRows = [];
  for (let r = 1; r + 3 < rows - 1; r += 4) bandRows.push(r);
  const band2 = seatProjects(room, projects, bandRows);
  const socialBands = addFacilities(room, bandRows, band2);
  addTalkArea(room, socialBands);
  addDecor(room, socialBands);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) if (grid[r][c] === "floor") room.walkable.push({ col: c, row: r });
  return room;
}
function seatProjects(room, projects, bandRows) {
  const wishlist = [];
  for (const p of projects) {
    let left = p.seats;
    while (left > 0) {
      const take = Math.min(MAX_RUN, left);
      wishlist.push({ proj: p.name, seats: take });
      left -= take;
    }
  }
  let band2 = 0;
  let n = 0;
  for (let i = 0; i < wishlist.length; ) {
    if (band2 >= bandRows.length) break;
    const monitorRow = bandRows[band2];
    const deskRow = monitorRow + 1;
    const seatRow = monitorRow + 2;
    let lo = 2;
    const hi = room.cols - 3;
    while (i < wishlist.length) {
      const want = wishlist[i];
      const span = want.seats * 2 - 1;
      if (lo + span - 1 > hi) break;
      const c0 = lo;
      const c1 = c0 + span - 1;
      for (let c = c0; c <= c1; c += 2) {
        room.grid[deskRow][c] = "desk";
        const id = `d${n++}`;
        room.spots.set(id, {
          id,
          kind: "desk",
          group: want.proj,
          col: c,
          row: seatRow,
          facing: "up",
          posture: "sit",
          zone: want.proj,
          taken: null
        });
        room.seatTiles.add(`${c},${seatRow}`);
        for (const r of [monitorRow, deskRow, seatRow]) room.zoneOf[r][c] ??= want.proj;
      }
      room.pods.push({ proj: want.proj, c0, c1, seatRow, deskRow, monitorRow });
      lo = c1 + 3;
      i++;
    }
    band2++;
  }
  for (const w of wishlist) {
    const seated = room.pods.filter((p) => p.proj === w.proj).reduce((a, p) => a + (p.c1 - p.c0 + 1), 0);
    const wanted = wishlist.filter((x) => x.proj === w.proj).reduce((a, x) => a + x.seats, 0);
    if (seated < wanted && !room.dropped.includes(w.proj)) room.hiddenCount += wanted - seated;
  }
  room.dropped = [];
  room.workBottom = room.pods.length ? Math.max(...room.pods.map((p) => p.seatRow)) + 1 : 1;
  return band2;
}
function addFacilities(room, bandRows, firstFree) {
  const below = room.workBottom + 2;
  const socialBands = bandRows.slice(firstFree).filter((r) => r >= below).slice(-2);
  let wish = ["couch", "kitchen", "couch", "pingpong", "couch"];
  while (socialBands.length * 2 < wish.length - 1 && DROP_ORDER.some((d) => wish.includes(d))) {
    const drop = DROP_ORDER.find((d) => wish.includes(d));
    wish = wish.filter((w) => w !== drop);
    room.dropped.push(drop);
  }
  let sb = 0;
  for (let i = 0; i < wish.length && sb < socialBands.length; ) {
    const row = socialBands[sb];
    let lo = 2;
    let hi = room.cols - 3;
    for (let side = 0; side < 2 && i < wish.length; side++) {
      const f = FACILITIES[wish[i]];
      if (!f || hi - lo + 1 < f.w + (side === 0 ? 2 : 0) || row + f.h > room.rows - 1) {
        i++;
        side--;
        if (i >= wish.length) break;
        continue;
      }
      const c0 = side === 0 ? lo : hi - f.w + 1;
      placeFacility(room, f, c0, row, `${wish[i]}@${row}`);
      if (side === 0) lo = c0 + f.w + 2;
      else hi = c0 - 1;
      i++;
    }
    sb++;
  }
  return socialBands;
}
function placeFacility(room, f, c0, r0, group) {
  for (const pr of f.props) {
    const lift = pr.dr > 0 && !pr.under ? TILE / 2 : 0;
    room.props.push({ kind: pr.kind, x: (c0 + pr.dc) * TILE, y: (r0 + pr.dr) * TILE - lift });
    if (pr.under) continue;
    const size = PROP_SIZE[pr.kind];
    for (let dr = 0; dr < size.h; dr++)
      for (let dc = 0; dc < size.w; dc++) {
        const c = c0 + pr.dc + dc;
        const r = r0 + pr.dr + dr;
        if (r > 0 && r < room.rows - 1 && c > 0 && c < room.cols - 1) room.grid[r][c] = "solid";
      }
  }
  f.spots.forEach(([dc, dr, facing, posture], k) => {
    const id = `${group}:${k}`;
    room.spots.set(id, {
      id,
      kind: f.kind,
      group,
      col: c0 + dc,
      row: r0 + dr,
      facing,
      posture,
      zone: null,
      taken: null
    });
    room.seatTiles.add(`${c0 + dc},${r0 + dr}`);
  });
}
function addTalkArea(room, socialBands) {
  const corridor = socialBands.length ? socialBands[0] - 2 : room.rows - 3;
  const below = room.workBottom + 2;
  let talkRow = -1;
  for (let r = Math.max(below, corridor); r < room.rows - 1 && talkRow < 0; r++)
    if ([2, 3].every((c) => room.grid[r][c] === "floor" && !room.seatTiles.has(`${c},${r}`))) talkRow = r;
  if (talkRow >= 0 && room.cols > 8) {
    const pair = [
      [2, "right"],
      [3, "left"]
    ];
    pair.forEach(([c, facing], k) => {
      const id = `talk@${talkRow}:${k}`;
      room.spots.set(id, {
        id,
        kind: "talk",
        group: `talk@${talkRow}`,
        col: c,
        row: talkRow,
        facing,
        posture: "stand",
        zone: null,
        taken: null
      });
      room.seatTiles.add(`${c},${talkRow}`);
    });
  }
  if (corridor > 1 && corridor < room.rows - 1) {
    room.spots.set("w0", {
      id: "w0",
      kind: "window",
      group: "window",
      col: room.cols - 2,
      row: corridor,
      facing: "right",
      posture: "stand",
      zone: null,
      taken: null
    });
  }
}
function addDecor(room, socialBands) {
  if (room.cols <= 14) return;
  room.props.push({ kind: "plant", x: 1 * TILE, y: (room.rows - 3) * TILE });
  room.props.push({ kind: "plant", x: (room.cols - 2) * TILE, y: 1 * TILE });
  room.grid[room.rows - 3][1] = "solid";
  room.grid[1][room.cols - 2] = "solid";
  room.props.push({ kind: "whiteboard", x: 3 * TILE, y: 0 });
  room.props.push({ kind: "shelf", x: (room.cols - 4) * TILE, y: 0 });
  const cr = socialBands.length ? socialBands[0] - 2 : room.rows - 3;
  if (cr > 1 && cr < room.rows - 2) {
    room.props.push({ kind: "cooler", x: 1 * TILE, y: cr * TILE });
    room.grid[cr][1] = "solid";
  }
}

// src/office/room.ts
var RoomBase = class {
  constructor(rng = Math.random) {
    this.rng = rng;
  }
  cols = 0;
  rows = 0;
  spots = /* @__PURE__ */ new Map();
  chars = /* @__PURE__ */ new Map();
  pods = [];
  hiddenCount = 0;
  dropped = [];
  /** where to place a monitor image this frame, and whether it is lit */
  monitors = [];
  /** project nameplates, drawn rotated as images beside each pod */
  plates = [];
  /** level badges, in the gap column beside each occupied desk */
  badges = [];
  /** static furniture image placements, in canvas pixels */
  props = [];
  /** cell spans covered by an image, per cell row. Kitty draws images over text,
   *  so a label must not overlap one — but sharing the row is fine. */
  imageSpans = /* @__PURE__ */ new Map();
  grid = [];
  zoneOf = [];
  walkable = [];
  seatTiles = /* @__PURE__ */ new Set();
  /** tile -> the character heading there or resting on it */
  dest = /* @__PURE__ */ new Map();
  signature = "";
  /** last row belonging to a desk band; downtime happens below this */
  workBottom = 0;
  /** project -> colour, assigned by index. A hash collides long before it runs
   *  out of colours, which is why several projects were sharing one. */
  zoneColor = /* @__PURE__ */ new Map();
  /** rally phase, advanced by update() so the ball moves with real time */
  ballT = 0;
  rand(a, b) {
    return a + this.rng() * (b - a);
  }
  randInt(a, b) {
    return Math.floor(this.rand(a, b + 1));
  }
  /* ───────────────────── floor plan ───────────────────── */
  /**
   * Re-lay the room and adopt the result. Planning is pure (see office/plan.ts);
   * this is the only place its output becomes state, which keeps the geometry
   * reasoning testable on its own and out of the simulation.
   */
  plan(cols, rows, projects) {
    const room = planRoom(cols, rows, projects);
    this.cols = room.cols;
    this.rows = room.rows;
    this.grid = room.grid;
    this.zoneOf = room.zoneOf;
    this.spots = room.spots;
    this.seatTiles = room.seatTiles;
    this.pods = room.pods;
    this.props = room.props;
    this.walkable = room.walkable;
    this.workBottom = room.workBottom;
    this.zoneColor = room.zoneColor;
    this.hiddenCount = room.hiddenCount;
    this.dropped = room.dropped;
  }
  /* ───────────────────── walkability & paths ───────────────────── */
  /** A spot tile is walkable only by whoever holds it, so nobody stands in
   *  someone else's chair — the reference's withOwnSeatUnblocked, inlined. */
  /** Is this tile open floor, ignoring who owns it? Used by reachability tests. */
  /** A project colour, for tests and callers that need it. */
  colourOf(proj) {
    return this.zoneColor.get(proj) ?? ROOFS[0];
  }
  isOpen(col, row) {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return false;
    return this.grid[row][col] === "floor";
  }
  isWalkable(col, row, own) {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return false;
    if (this.grid[row][col] !== "floor") return false;
    const k = `${col},${row}`;
    return !this.seatTiles.has(k) || k === own;
  }
  findPath(sc, sr, ec, er, own) {
    if (sc === ec && sr === er) return [];
    if (!this.isWalkable(ec, er, own)) return [];
    const key = (c, r) => `${c},${r}`;
    const prev = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set([key(sc, sr)]);
    let queue = [{ col: sc, row: sr }];
    while (queue.length) {
      const next = [];
      for (const cur of queue) {
        for (const [dc, dr] of [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0]
        ]) {
          const c = cur.col + dc;
          const r = cur.row + dr;
          const k = key(c, r);
          if (seen.has(k) || !this.isWalkable(c, r, own)) continue;
          seen.add(k);
          prev.set(k, key(cur.col, cur.row));
          if (c === ec && r === er) {
            const out = [];
            let at = k;
            while (at !== key(sc, sr)) {
              const [pc, pr] = at.split(",").map(Number);
              out.push({ col: pc, row: pr });
              at = prev.get(at);
            }
            return out.reverse();
          }
          next.push({ col: c, row: r });
        }
      }
      queue = next;
    }
    return [];
  }
  /* ───────────────────── population ───────────────────── */
  /** Re-plan only when the viewport or the project mix actually changes. */
  fit(wPx, hPx, sessions3) {
    const cols = Math.max(12, Math.min(Math.floor(wPx / TILE), Math.floor(wPx / TILE)));
    const rows = Math.max(8, Math.floor(hPx / TILE));
    const byProj = /* @__PURE__ */ new Map();
    for (const s of sessions3) byProj.set(s.proj, (byProj.get(s.proj) ?? 0) + 1);
    const projects = [...byProj.entries()].map(([name, seats]) => ({ name, seats })).sort((a, b) => b.seats - a.seats || a.name.localeCompare(b.name));
    const sig = `${cols}x${rows}|${projects.map((p) => `${p.name}:${p.seats}`).join(",")}`;
    if (sig === this.signature) return;
    this.signature = sig;
    this.plan(cols, rows, projects);
    this.relocate();
  }
  /** After a re-plan, put everybody somewhere legal or they are stranded forever. */
  relocate() {
    for (const ch of this.chars.values()) {
      const seat = ch.seatId ? this.spots.get(ch.seatId) : void 0;
      if (seat) {
        ch.col = seat.col;
        ch.row = seat.row;
      } else if (!this.isWalkable(ch.col, ch.row)) {
        const t = this.walkable[Math.floor(this.rng() * this.walkable.length)];
        if (t) {
          ch.col = t.col;
          ch.row = t.row;
        }
      }
      ch.x = ch.col * TILE + TILE / 2;
      ch.y = ch.row * TILE + TILE / 2;
      ch.path = [];
      ch.progress = 0;
      this.release(ch);
      this.unreserve(ch);
      this.reserve(ch, ch.col, ch.row);
      if (ch.state === "walk") ch.state = "idle";
    }
  }
  /** Claim and release. Existing claims are never disturbed — that stickiness
   *  is what stops characters being re-targeted onto occupied chairs. */
  assign(sessions3) {
    const byId = new Map(sessions3.map((s) => [s.id, s]));
    for (const [id, ch] of [...this.chars]) {
      if (byId.has(id)) continue;
      const st = ch.seatId ? this.spots.get(ch.seatId) : void 0;
      if (st?.taken === id) st.taken = null;
      this.release(ch);
      this.unreserve(ch);
      this.chars.delete(id);
    }
    for (const spot of this.spots.values()) if (spot.taken && !this.chars.has(spot.taken)) spot.taken = null;
    for (const ch of this.chars.values()) if (ch.seatId && !this.spots.has(ch.seatId)) ch.seatId = null;
    for (const ch of [...this.chars.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!ch.seatId) continue;
      const spot = this.spots.get(ch.seatId);
      if (!spot || spot.kind !== "desk" || spot.taken && spot.taken !== ch.id) {
        ch.seatId = null;
        continue;
      }
      spot.taken = ch.id;
    }
    const desks = [...this.spots.values()].filter((s) => s.kind === "desk").sort((a, b) => a.row - b.row || a.col - b.col);
    const newcomers = sessions3.filter((s) => !this.chars.has(s.id) || !this.chars.get(s.id).seatId).sort((a, b) => RANK[a.state] - RANK[b.state] || a.id.localeCompare(b.id));
    for (const s of newcomers) {
      const seat = this.claimDesk(s, desks);
      if (!seat) continue;
      seat.taken = s.id;
      const existing = this.chars.get(s.id);
      if (existing) existing.seatId = seat.id;
      else this.chars.set(s.id, this.spawn(s, seat));
    }
    this.hiddenCount = sessions3.filter((s) => !this.chars.get(s.id)?.seatId).length;
  }
  /** Nearest free desk to the project's existing cluster, never evicting anyone. */
  claimDesk(s, desks) {
    const free = desks.filter((d) => !d.taken);
    if (!free.length) return null;
    const mine = free.filter((d) => d.zone === s.proj);
    if (mine.length) return mine[0];
    const cluster = desks.filter((d) => d.taken && d.zone === s.proj);
    if (!cluster.length) return free[0];
    let best = free[0];
    let bestD = Infinity;
    for (const f of free) {
      const d = Math.min(...cluster.map((m) => Math.abs(m.col - f.col) + Math.abs(m.row - f.row)));
      if (d < bestD) {
        best = f;
        bestD = d;
      }
    }
    return best;
  }
  /**
   * Born where this session would already be, not always in the chair.
   *
   * Everyone used to spawn typing at a desk regardless of what their session was
   * doing, so launching with eight parked sessions and two working ones drew ten
   * people hard at work — the room's single most important claim, and it was
   * false for about a minute until they all got up and wandered off. Starting at
   * a doorway was the older mistake in the other direction; the answer to both is
   * to start in the state the session is actually in.
   *
   * The seat is still claimed either way. A desk is the project's identity — its
   * nameplate, its level badge, its carpet — and giving it up because nobody is
   * sitting there would empty the room of exactly the information it exists to
   * show. The character simply is not in it.
   */
  spawn(s, seat) {
    const working = this.atDesk(s);
    const ch = {
      id: s.id,
      state: working ? "type" : "idle",
      dir: seat.facing,
      x: seat.col * TILE + TILE / 2,
      y: seat.row * TILE + TILE / 2,
      col: seat.col,
      row: seat.row,
      path: [],
      progress: 0,
      frame: 0,
      frameTimer: 0,
      // zero, so somebody who is not working leaves on the very first tick
      // instead of sitting there for the usual two-to-twelve second pause
      idleTimer: 0,
      seatTimer: 0,
      seatId: seat.id,
      activity: null,
      wasWorking: working,
      chatWanted: false,
      bubble: null,
      bubbleTimer: 0
    };
    return ch;
  }
  /* ───────────────────── simulation ───────────────────── */
  /** Blocked on your approval is still mid-turn, so it stays at the desk. */
  atDesk = (s) => s.state === "working" || s.state === "shell" || s.state === "needs";
  /* ── claims and reservations ──
   * These live with the room rather than the simulation: they are operations on
   * who owns a tile, and assign() needs them before any simulation runs. */
  /** One teardown for every exit, so no claim or pairing can leak. */
  release(ch) {
    const act = ch.activity;
    if (!act) return;
    if (act.spotId) {
      const sp = this.spots.get(act.spotId);
      if (sp?.taken === ch.id) sp.taken = null;
    }
    if (act.partner) {
      const p = this.chars.get(act.partner);
      if (p?.activity?.partner === ch.id) {
        if (p.activity.spotId) {
          const sp = this.spots.get(p.activity.spotId);
          if (sp?.taken === p.id) sp.taken = null;
        }
        p.activity = null;
        if (p.state === "act") p.state = "idle";
      }
    }
    ch.activity = null;
    ch.chatWanted = false;
  }
  reserve(ch, col, row) {
    const k = `${col},${row}`;
    const holder = this.dest.get(k);
    if (holder && holder !== ch.id) return false;
    this.unreserve(ch);
    this.dest.set(k, ch.id);
    return true;
  }
  unreserve(ch) {
    for (const [k, id] of this.dest) if (id === ch.id) this.dest.delete(k);
  }
  /** Free floor that nobody else is heading to or standing on. */
  freeTiles() {
    const open2 = this.walkable.filter((t) => {
      const k = `${t.col},${t.row}`;
      return !this.dest.get(k) && !this.seatTiles.has(k);
    });
    const social = open2.filter((t) => t.row > this.workBottom + 1);
    return social.length ? social : open2;
  }
};

// src/office/sim.ts
var SimBase = class extends RoomBase {
  /**
   * Run the room forward until it looks lived-in, before anyone sees it.
   *
   * Characters are born at their desk — that is where a session's identity is —
   * so the first frame of a fresh launch had everyone standing in a chair,
   * including the eight of ten who were parked. They walk off within seconds, but
   * the opening image is the one that gets believed, and "everyone is at their
   * computer" is the single most misleading thing this room can say.
   *
   * Twenty seconds of simulation is where the walking stops: measured, 600 ticks
   * leaves nobody mid-path and only the desk-bound five in a seat. It costs ~50ms
   * once, which is invisible next to the poll that produced the sessions.
   */
  settle(sessions3, seconds = 20) {
    const step = 1 / 30;
    for (let i = 0; i < Math.round(seconds / step); i++) this.update(step, sessions3);
  }
  update(dt, sessions3) {
    this.ballT += dt * 1.6;
    const byId = new Map(sessions3.map((s) => [s.id, s]));
    for (const ch of this.chars.values()) {
      const s = byId.get(ch.id);
      if (!s) continue;
      const working = this.atDesk(s);
      this.bubbleFor(ch, s, dt);
      if (ch.wasWorking && !working) {
        ch.seatTimer = -1;
        ch.path = [];
        ch.progress = 0;
      }
      ch.wasWorking = working;
      ch.frameTimer += dt;
      switch (ch.state) {
        case "type": {
          if (ch.frameTimer >= TYPE_FRAME_SEC) {
            ch.frameTimer -= TYPE_FRAME_SEC;
            ch.frame ^= 1;
          }
          if (working) break;
          if (ch.seatTimer > 0) {
            ch.seatTimer -= dt;
            break;
          }
          ch.seatTimer = 0;
          ch.state = "idle";
          ch.frame = 0;
          ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX);
          break;
        }
        case "act": {
          if (ch.frameTimer >= TYPE_FRAME_SEC) {
            ch.frameTimer -= TYPE_FRAME_SEC;
            ch.frame ^= 1;
          }
          if (working) {
            this.release(ch);
            if (!this.walkToSeat(ch)) ch.state = "type";
            break;
          }
          const act = ch.activity;
          if (!act) {
            ch.state = "idle";
            break;
          }
          if (act.partner) {
            const p = this.chars.get(act.partner);
            const ps = p ? byId.get(p.id) : void 0;
            if (!p || !ps || this.atDesk(ps)) {
              this.release(ch);
              ch.state = "idle";
              ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX);
              break;
            }
            if (p.state !== "act") break;
          }
          act.timer -= dt;
          if (act.timer <= 0) {
            this.release(ch);
            ch.state = "idle";
            ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX);
          }
          break;
        }
        case "idle": {
          ch.frame = 0;
          const beside = (dc) => [...this.chars.values()].find((o) => o !== ch && o.state !== "walk" && o.row === ch.row && o.col === ch.col + dc);
          const right = beside(1);
          const left = beside(-1);
          const backToBack = (face) => {
            const behind = face === "right" ? left : right;
            return !!behind && behind.dir === (face === "right" ? "left" : "right");
          };
          if (right && !(backToBack("right") && left && !backToBack("left"))) ch.dir = "right";
          else if (left) ch.dir = "left";
          else if (right) ch.dir = "right";
          if (ch.seatTimer < 0) ch.seatTimer = 0;
          if (working) {
            this.release(ch);
            if (!this.walkToSeat(ch)) {
              ch.state = "type";
              ch.frameTimer = 0;
            }
            break;
          }
          ch.idleTimer -= dt;
          if (ch.idleTimer > 0) break;
          ch.idleTimer = this.rand(IDLE_PAUSE_MIN, IDLE_PAUSE_MAX);
          if (this.rng() < 0.35) {
            ch.chatWanted = true;
            break;
          }
          if (this.goToSpot(ch)) break;
          const open2 = this.freeTiles();
          const t = open2[Math.floor(this.rng() * open2.length)];
          if (t) this.walkTo(ch, t.col, t.row);
          break;
        }
        case "walk": {
          if (ch.frameTimer >= WALK_FRAME_SEC) {
            ch.frameTimer -= WALK_FRAME_SEC;
            ch.frame = (ch.frame + 1) % 4;
          }
          if (working) {
            const seat2 = ch.seatId ? this.spots.get(ch.seatId) : void 0;
            const last2 = ch.path[ch.path.length - 1];
            if (seat2 && (!last2 || last2.col !== seat2.col || last2.row !== seat2.row)) {
              this.release(ch);
              this.walkToSeat(ch);
            }
          }
          this.step(ch, dt);
          if (ch.path.length) break;
          ch.x = ch.col * TILE + TILE / 2;
          ch.y = ch.row * TILE + TILE / 2;
          const seat = ch.seatId ? this.spots.get(ch.seatId) : void 0;
          if (seat && seat.col === ch.col && seat.row === ch.row) {
            ch.state = "type";
            ch.dir = seat.facing;
            ch.frame = 0;
            ch.frameTimer = 0;
            ch.seatTimer = ch.seatTimer < 0 ? 0 : this.rand(SEAT_REST_MIN, SEAT_REST_MAX);
            break;
          }
          const act = ch.activity;
          const spot = act?.spotId ? this.spots.get(act.spotId) : void 0;
          if (act && spot && spot.col === ch.col && spot.row === ch.row) {
            ch.state = "act";
            ch.dir = spot.facing;
            ch.frame = 0;
            break;
          }
          if (act?.partner) {
            const p = this.chars.get(act.partner);
            if (p) ch.dir = Math.abs(p.col - ch.col) >= Math.abs(p.row - ch.row) ? p.col > ch.col ? "right" : "left" : p.row > ch.row ? "down" : "up";
            ch.state = "act";
            break;
          }
          ch.state = "idle";
          break;
        }
      }
    }
    if ([...this.chars.values()].filter((c) => c.chatWanted).length >= 2) this.brokerChats(byId);
  }
  bubbleFor(ch, s, dt) {
    if (s.state === "needs") {
      ch.bubble = "permission";
      return;
    }
    if (ch.bubble === "permission") ch.bubble = null;
    if (ch.activity?.partner) {
      ch.bubble = "chat";
      return;
    }
    if (ch.bubble === "chat") ch.bubble = null;
    if (s.state === "done" && s.stale < DONE_BUBBLE_SEC * 1e3 && ch.bubble !== "done") {
      ch.bubble = "done";
      ch.bubbleTimer = DONE_BUBBLE_SEC;
    }
    if (ch.bubble === "done") {
      ch.bubbleTimer -= dt;
      if (ch.bubbleTimer <= 0) ch.bubble = null;
    }
  }
  /** Prefer a facility someone is already at, which is what makes a group read
   *  as a group without any explicit socialising logic. */
  goToSpot(ch) {
    const free = [...this.spots.values()].filter((s) => s.kind !== "desk" && s.kind !== "pingpong" && !s.taken);
    if (!free.length) return false;
    const busyGroups = new Set([...this.spots.values()].filter((s) => s.taken && s.kind !== "desk").map((s) => s.group));
    const scored = free.map((s) => ({
      s,
      score: (busyGroups.has(s.group) ? -1e3 : 0) + Math.abs(s.col - ch.col) + Math.abs(s.row - ch.row)
    })).sort((a, b) => a.score - b.score);
    for (const { s } of scored) {
      s.taken = ch.id;
      ch.activity = { kind: s.kind, spotId: s.id, partner: null, timer: this.rand(...DWELL[s.kind]) };
      if (this.walkTo(ch, s.col, s.row, `${s.col},${s.row}`)) return true;
      s.taken = null;
      ch.activity = null;
    }
    return false;
  }
  /** Deterministic id-ordered pairing: two idle characters stand and talk. */
  brokerChats(byId) {
    const waiting = [...this.chars.values()].filter((c) => c.state === "idle" && c.chatWanted && !c.activity && !this.atDesk(byId.get(c.id))).sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < waiting.length; i++) {
      const a = waiting[i];
      if (a.activity) continue;
      for (let j = i + 1; j < waiting.length; j++) {
        const b = waiting[j];
        if (b.activity) continue;
        if (Math.abs(a.col - b.col) + Math.abs(a.row - b.row) > CHAT_RADIUS) continue;
        const table = [...new Set([...this.spots.values()].filter((x) => x.kind === "pingpong").map((x) => x.group))].map((g) => [...this.spots.values()].filter((x) => x.group === g)).find((pair2) => pair2.length === 2 && pair2.every((x) => !x.taken));
        if (table) {
          const [t0, t1] = table;
          const d = this.rand(...DWELL.pingpong);
          t0.taken = a.id;
          t1.taken = b.id;
          a.activity = { kind: "pingpong", spotId: t0.id, partner: b.id, timer: d };
          b.activity = { kind: "pingpong", spotId: t1.id, partner: a.id, timer: d };
          a.chatWanted = b.chatWanted = false;
          if (this.walkTo(a, t0.col, t0.row, `${t0.col},${t0.row}`) && this.walkTo(b, t1.col, t1.row, `${t1.col},${t1.row}`)) break;
          this.release(a);
          this.release(b);
        }
        const dur = this.rand(...DWELL.talk);
        const area = [...this.spots.values()].filter((s) => s.kind === "talk" && !s.taken);
        if (area.length >= 2) {
          const [s0, s1] = area;
          s0.taken = a.id;
          s1.taken = b.id;
          a.activity = { kind: "talk", spotId: s0.id, partner: b.id, timer: dur };
          b.activity = { kind: "talk", spotId: s1.id, partner: a.id, timer: dur };
          a.chatWanted = b.chatWanted = false;
          if (this.walkTo(a, s0.col, s0.row, `${s0.col},${s0.row}`) && this.walkTo(b, s1.col, s1.row, `${s1.col},${s1.row}`)) break;
          this.release(a);
          this.release(b);
        }
        const pair = this.findTalkPair(a, b);
        if (!pair) continue;
        a.activity = { kind: "talk", spotId: null, partner: b.id, timer: dur };
        b.activity = { kind: "talk", spotId: null, partner: a.id, timer: dur };
        a.chatWanted = b.chatWanted = false;
        this.walkTo(a, pair[0].col, pair[0].row);
        this.walkTo(b, pair[1].col, pair[1].row);
        break;
      }
    }
  }
  /** Two side-by-side free floor tiles near the midpoint of the pair. */
  findTalkPair(a, b) {
    const mc = Math.round((a.col + b.col) / 2);
    const mr = Math.round((a.row + b.row) / 2);
    let best = null;
    let bestD = Infinity;
    for (const t of this.freeTiles()) {
      const d = Math.abs(t.col - mc) + Math.abs(t.row - mr);
      if (d >= bestD) continue;
      const right = { col: t.col + 1, row: t.row };
      if (!this.isWalkable(right.col, right.row)) continue;
      if (this.dest.has(`${right.col},${right.row}`)) continue;
      best = [t, right];
      bestD = d;
    }
    return best;
  }
  walkToSeat(ch) {
    const seat = ch.seatId ? this.spots.get(ch.seatId) : void 0;
    if (!seat) return false;
    if (seat.col === ch.col && seat.row === ch.row) {
      ch.state = "type";
      ch.dir = seat.facing;
      ch.frameTimer = 0;
      ch.seatTimer = 0;
      return true;
    }
    return this.walkTo(ch, seat.col, seat.row, `${seat.col},${seat.row}`);
  }
  /**
   * Reserve a destination tile. Two characters may pass through each other while
   * walking — the reference allows that too — but they must never come to rest
   * on the same tile, so the target is claimed before the path is taken.
   */
  walkTo(ch, col, row, own) {
    if (!this.reserve(ch, col, row)) return false;
    const path = this.findPath(ch.col, ch.row, col, row, own);
    if (!path.length) {
      this.unreserve(ch);
      return false;
    }
    ch.path = path;
    ch.progress = 0;
    ch.state = "walk";
    ch.frame = 0;
    return true;
  }
  step(ch, dt) {
    const next = ch.path[0];
    if (!next) return;
    ch.dir = next.col > ch.col ? "right" : next.col < ch.col ? "left" : next.row > ch.row ? "down" : "up";
    ch.progress += dt * WALK_TILES_PER_SEC;
    while (ch.progress >= 1 && ch.path.length) {
      ch.progress -= 1;
      const t = ch.path.shift();
      ch.col = t.col;
      ch.row = t.row;
    }
    if (!ch.path.length) ch.progress = 0;
    const from = { x: ch.col * TILE + TILE / 2, y: ch.row * TILE + TILE / 2 };
    const ahead = ch.path[0];
    if (ahead) {
      ch.x = from.x + (ahead.col * TILE + TILE / 2 - from.x) * ch.progress;
      ch.y = from.y + (ahead.row * TILE + TILE / 2 - from.y) * ch.progress;
    } else {
      ch.x = from.x;
      ch.y = from.y;
    }
  }
  /* ───────────────────── drawing ───────────────────── */
};

// src/office.ts
var Office = class extends SimBase {
  /** whether nameplates are drawn as rotated images beside each pod */
  vertical = false;
  draw(cv2, sessions3) {
    const byId = new Map(sessions3.map((s) => [s.id, s]));
    cv2.clear(C.floorDark);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = c * TILE;
        const y = r * TILE;
        switch (this.grid[r][c]) {
          case "wall":
            cv2.rect(x, y, TILE, TILE, C.wallStone);
            cv2.rect(x, y, TILE, 1, C.wallLip);
            break;
          case "desk":
            break;
          // drawn below, after the carpets
          default:
            cv2.rect(x, y, TILE, TILE, (r + c) % 2 ? C.floor : C.floorAlt);
        }
      }
    }
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const z = this.zoneOf[r][c];
        if (!z) continue;
        const col = this.zoneColor.get(z) ?? ROOFS[0];
        cv2.tint(c * TILE, r * TILE, TILE, TILE, col, 0.2);
        if (this.zoneOf[r - 1]?.[c] !== z) for (let i = 0; i < TILE; i++) cv2.set(c * TILE + i, r * TILE, col);
        if (this.zoneOf[r + 1]?.[c] !== z) for (let i = 0; i < TILE; i++) cv2.set(c * TILE + i, r * TILE + TILE - 1, col);
        if (this.zoneOf[r][c - 1] !== z) for (let i = 0; i < TILE; i++) cv2.set(c * TILE, r * TILE + i, col);
        if (this.zoneOf[r][c + 1] !== z) for (let i = 0; i < TILE; i++) cv2.set(c * TILE + TILE - 1, r * TILE + i, col);
      }
    }
    this.imageSpans.clear();
    const block = (x, y, w, hRows) => {
      for (let i = 0; i < hRows; i++) {
        const row = (y >> 1) + i;
        const arr = this.imageSpans.get(row) ?? [];
        arr.push([x, x + w]);
        this.imageSpans.set(row, arr);
      }
    };
    this.monitors = [];
    this.badges = [];
    this.plates = [];
    const lit = /* @__PURE__ */ new Map();
    const levels = /* @__PURE__ */ new Map();
    const asking = /* @__PURE__ */ new Set();
    for (const sp of this.spots.values()) {
      if (sp.kind !== "desk" || !sp.taken) continue;
      const s = byId.get(sp.taken);
      if (s) levels.set(`${sp.col},${sp.row}`, s.level);
      if (s && s.state === "needs") asking.add(`${sp.col},${sp.row}`);
      if (s && (this.atDesk(s) || s.stale < SCREEN_HOLD)) lit.set(`${sp.col},${sp.row}`, s.toolKind);
    }
    for (const pod of this.pods)
      for (let c = pod.c0; c <= pod.c1; c += 2) {
        this.monitors.push({
          x: c * TILE,
          y: pod.monitorRow * TILE,
          lit: lit.has(`${c},${pod.seatRow}`),
          seed: c + pod.monitorRow,
          kind: lit.get(`${c},${pod.seatRow}`) ?? "think"
        });
        block(c * TILE, pod.monitorRow * TILE, MON_COLS, MON_ROWS);
        const lvl = levels.get(`${c},${pod.seatRow}`) ?? 0;
        if (lvl) {
          this.badges.push({ x: c * TILE + TILE, y: pod.deskRow * TILE, level: lvl, asking: false });
          block(c * TILE + TILE, pod.deskRow * TILE, TILE, TILE / 2);
        }
        if (asking.has(`${c},${pod.seatRow}`)) {
          this.badges.push({ x: c * TILE + TILE, y: pod.monitorRow * TILE, level: 0, asking: true });
          block(c * TILE + TILE, pod.monitorRow * TILE, TILE, TILE / 2);
        }
      }
    if (this.vertical) {
      const named = /* @__PURE__ */ new Set();
      for (const pod of this.pods) {
        if (named.has(pod.proj)) continue;
        const x = pod.c0 * TILE - PLATE_COLS;
        if (x < 0) continue;
        named.add(pod.proj);
        this.plates.push({ x, y: pod.monitorRow * TILE, proj: pod.proj, colour: this.zoneColor.get(pod.proj) ?? ROOFS[0] });
        block(x, pod.monitorRow * TILE, PLATE_COLS, PLATE_ROWS);
      }
    }
    for (const pr of this.props) {
      const size = PROP_SIZE[pr.kind];
      block(pr.x, pr.y, size.w * TILE, size.h * TILE / 2);
    }
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const k = this.grid[r][c];
        if (k === "desk") drawDesk(cv2, c * TILE, r * TILE, lit.has(`${c},${r + 1}`));
        else if (k === "solid") cv2.rect(c * TILE, r * TILE, TILE, TILE, C.floorDark);
      }
    for (const g of new Set([...this.spots.values()].filter((x) => x.kind === "pingpong").map((x) => x.group))) {
      const pair = [...this.spots.values()].filter((x2) => x2.group === g);
      if (pair.length !== 2) continue;
      const playing = pair.every((sp) => {
        if (!sp.taken) return false;
        const ch = this.chars.get(sp.taken);
        return !!ch && ch.state === "act" && ch.col === sp.col && ch.row === sp.row;
      });
      if (!playing) continue;
      const t = (this.ballT % 1 + 1) % 1;
      const swing = t < 0.5 ? t * 2 : (1 - t) * 2;
      const x = pair[0].col * TILE + (pair[1].col - pair[0].col) * TILE * swing + TILE / 2;
      const y = pair[0].row * TILE + TILE / 2 - Math.round(Math.sin(swing * Math.PI) * 3);
      cv2.set(Math.round(x), Math.round(y), [252, 252, 240]);
      cv2.set(Math.round(x), Math.round(y) - 1, [220, 220, 200]);
    }
    const out = [];
    for (const ch of [...this.chars.values()].sort((a, b) => a.y - b.y)) {
      const s = byId.get(ch.id);
      if (!s) continue;
      const seated = ch.state === "type" || ch.state === "act" && this.postureOf(ch) === "sit";
      const pose = seated ? "typing" : "walk";
      const rally = ch.activity?.kind === "pingpong";
      const step = seated || rally || ch.state === "walk" ? ch.frame : 1;
      const y = Math.round(ch.y - CHAR_H + (seated ? SIT_SINK : 0));
      out.push({ s, ch, facing: ch.dir, pose, step, x: Math.round(ch.x - CHAR_W / 2), y: y - (y & 1) });
    }
    return out;
  }
  postureOf(ch) {
    const id = ch.activity?.spotId;
    return id ? this.spots.get(id)?.posture ?? "stand" : "stand";
  }
  /**
   * Project nameplates and per-character status labels.
   *
   * `vertical` runs the name down the column beside the pod instead of along the
   * aisle beneath it. A horizontal plate is as wide as the name, which is what
   * forced every long project to truncate and what made neighbouring plates fight
   * over the same row; a vertical one costs one column and as many rows as the
   * band already has, so the room reads as columns of desks rather than a wall of
   * labels.
   */
  overlay(cv2, placed, selected, showAll = true) {
    if (!this.vertical) this.horizontalPlates(cv2);
    return this.labels(cv2, placed, selected, showAll);
  }
  horizontalPlates(cv2) {
    const named = /* @__PURE__ */ new Set();
    const claimed = /* @__PURE__ */ new Map();
    const blocks = (row) => claimed.get(row) ?? [];
    for (const pod of [...this.pods].sort((a, b) => b.c1 - b.c0 - (a.c1 - a.c0))) {
      if (named.has(pod.proj)) continue;
      named.add(pod.proj);
      const band2 = this.pods.filter((p) => p.deskRow === pod.deskRow);
      const rightOf = band2.filter((p) => p.c0 > pod.c1).sort((a, b) => a.c0 - b.c0);
      const leftOf = band2.filter((p) => p.c1 < pod.c0).sort((a, b) => b.c1 - a.c1);
      const plateRow = Math.min(cv2.rows - 1, Math.floor((pod.seatRow + 1) * TILE / 2));
      const here = blocks(plateRow);
      const left0 = pod.c0 * TILE;
      const right0 = (pod.c1 + 1) * TILE;
      const podRight = (rightOf.length ? rightOf[0].c0 : this.cols - 1) * TILE;
      const wallRight = Math.min(podRight, ...here.filter((b) => b[0] >= left0).map((b) => b[0]));
      const podLeft = (leftOf.length ? leftOf[0].c1 + 1 : 1) * TILE;
      const wallLeft = Math.max(podLeft, ...here.filter((b) => b[1] <= right0).map((b) => b[1]));
      const roomRight = wallRight - left0 - 1;
      const roomLeft = right0 - wallLeft - 1;
      const span = Math.max(roomRight, roomLeft);
      if (span < 5) continue;
      const text = ` ${cut(pod.proj, Math.max(3, span - 2))} `;
      const startCol = Math.max(0, roomLeft > roomRight ? right0 - text.length : left0);
      cv2.text(startCol, plateRow, text, C.ink, this.zoneColor.get(pod.proj) ?? ROOFS[0]);
      claimed.set(plateRow, [...here, [startCol, startCol + text.length]]);
      const spans = this.imageSpans.get(plateRow) ?? [];
      spans.push([startCol, startCol + text.length]);
      this.imageSpans.set(plateRow, spans);
    }
  }
  /** Per-character status labels, which are the same either way. */
  labels(cv2, placed, selected, showAll = true) {
    for (const p of placed) {
      for (let i = 0; i < CHAR_H / 2; i++) {
        const row = (p.y >> 1) + i;
        const arr = this.imageSpans.get(row) ?? [];
        arr.push([p.x, p.x + CHAR_W]);
        this.imageSpans.set(row, arr);
      }
    }
    const taken = /* @__PURE__ */ new Map();
    for (const p of [...placed].sort((a, b) => RANK[a.s.state] - RANK[b.s.state] || a.x - b.x)) {
      const s = p.s;
      const look = LOOK[s.state];
      const sel = s.id === selected;
      const urgent = s.state === "needs" || s.state === "error";
      if (!urgent && !sel) continue;
      const row = p.y >> 1;
      const rows = [...Array(CHAR_H / 2).keys()].map((i) => row + i);
      rows.push(row - 1, row + CHAR_H / 2);
      const spots = [];
      for (const r of rows) spots.push([r, p.x + CHAR_W], [r, p.x - 1]);
      const free = spots.filter(([r, c]) => r >= 0 && r < cv2.rows && c >= 0 && c < cv2.w && !this.blocked(r, c, 1, taken));
      if (!free.length) continue;
      const body = s.short || (s.state === "working" || s.state === "shell" ? s.doing : s.title) || s.title;
      const prefix = s.tab ? `\u2318${s.tab} ` : "";
      const want = prefix.length + 27;
      const least = prefix.length + 6;
      const room = ([r, c]) => {
        const step = c < p.x ? -1 : 1;
        let n2 = 0;
        while (n2 < want) {
          const x = c + step * (n2 + 1);
          if (x < 0 || x >= cv2.w || this.blocked(r, x, 1, taken)) break;
          n2++;
        }
        return n2;
      };
      const at = free.find((sp) => room(sp) >= least) ?? free[0];
      const [badgeRow, badgeCol] = at;
      cv2.text(badgeCol, badgeRow, look.glyph, C.night, look.color);
      const mine = taken.get(badgeRow) ?? [];
      mine.push([badgeCol, badgeCol + 1]);
      taken.set(badgeRow, mine);
      if (!showAll && !urgent && !sel) continue;
      const n = room(at);
      if (n < least) continue;
      const text = `${prefix}${cut(body, n - prefix.length - 1)} `;
      const fits = badgeCol < p.x ? badgeCol - text.length : badgeCol + 1;
      cv2.text(fits, badgeRow, text, C.ink, urgent ? look.color : C.paper);
      const used = taken.get(badgeRow) ?? [];
      used.push([fits, fits + text.length]);
      taken.set(badgeRow, used);
    }
  }
  /** Is this run free of other text and of any image? */
  blocked(row, col, len, taken) {
    const spans = [...taken.get(row) ?? [], ...this.imageSpans.get(row) ?? []];
    return spans.some((r) => col < r[1] && col + len > r[0]);
  }
};
function drawDesk(cv2, x, y, lit) {
  cv2.rect(x, y, TILE, TILE, C.deskTop);
  cv2.rect(x, y, TILE, 1, C.deskEdge);
  cv2.rect(x, y + TILE - 1, TILE, 1, C.deskEdge);
  if (lit) cv2.tint(x, y, TILE, TILE, C.screenOn, 0.28);
}

// src/characters.ts
var FRAME_W = 16;
var FRAME_H = 32;
var ROWS = ["down", "up", "right"];
var POSE_FRAMES = {
  walk: [0, 1, 2, 1],
  // 3 drawn frames make a 4-step cycle
  typing: [3, 4],
  reading: [5, 6]
};
var sheets = [];
function setSheets(imgs) {
  sheets.length = 0;
  sheets.push(...imgs);
  cache2.clear();
}
function extract(img, rowIdx, frame2, flip) {
  const x0 = frame2 * FRAME_W;
  const y0 = rowIdx * FRAME_H;
  const grid = [];
  for (let y = 0; y < FRAME_H; y++) {
    const row = [];
    for (let x = 0; x < FRAME_W; x++) {
      const sx = flip ? x0 + (FRAME_W - 1 - x) : x0 + x;
      const i = ((y0 + y) * img.w + sx) * 4;
      row.push(img.rgba[i + 3] < 128 ? null : [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]);
    }
    grid.push(row);
  }
  return { w: FRAME_W, h: FRAME_H, grid };
}
function hueRotate(g, deg) {
  if (!deg) return g;
  const a = deg * Math.PI / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072
  ];
  const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  return {
    w: g.w,
    h: g.h,
    grid: g.grid.map(
      (row) => row.map(
        (p) => p ? [
          clamp(p[0] * m[0] + p[1] * m[1] + p[2] * m[2]),
          clamp(p[0] * m[3] + p[1] * m[4] + p[2] * m[5]),
          clamp(p[0] * m[6] + p[1] * m[7] + p[2] * m[8])
        ] : null
      )
    )
  };
}
var cache2 = /* @__PURE__ */ new Map();
function pinBadge(g, colour) {
  const grid = g.grid.map((row) => [...row]);
  const top = Math.round(g.h * 0.58);
  for (let y = top; y < Math.min(g.h, top + 6); y++) {
    const row = grid[y];
    const first = row.findIndex((c) => c);
    const last2 = row.reduce((acc, c, i) => c ? i : acc, -1);
    if (first < 0 || last2 - first < 3) continue;
    const x = first + 1;
    const edge = [24, 26, 34];
    for (let dy = 0; dy < 3; dy++)
      for (let dx = 0; dx < 3; dx++) {
        const r = grid[y + dy];
        if (!r || !r[x + dx]) continue;
        r[x + dx] = dy === 0 || dx === 0 ? edge : colour;
      }
    return { w: g.w, h: g.h, grid };
  }
  return { w: g.w, h: g.h, grid };
}
var BLANK = { w: FRAME_W, h: FRAME_H, grid: Array.from({ length: FRAME_H }, () => new Array(FRAME_W).fill(null)) };
function frameOf(palette, hueShift, facing, pose, step, badge2) {
  if (!sheets.length) return BLANK;
  const key = `${palette}:${hueShift}:${facing}:${pose}:${step}:${badge2?.join("") ?? ""}`;
  const hit = cache2.get(key);
  if (hit) return hit;
  const sheet = sheets[palette % sheets.length];
  const cycle = POSE_FRAMES[pose];
  const frame2 = cycle[step % cycle.length];
  const rowIdx = ROWS.indexOf(facing === "left" ? "right" : facing);
  let g = hueRotate(extract(sheet, rowIdx < 0 ? 0 : rowIdx, frame2, facing === "left"), hueShift);
  if (badge2) g = pinBadge(g, badge2);
  cache2.set(key, g);
  return g;
}

// src/screens.ts
var W = 16;
var H = 24;
var CASE = [46, 48, 62];
var CASE_LIT = [72, 76, 96];
var BASE = [38, 40, 52];
var DARK = [22, 24, 32];
var CODE = [
  [126, 220, 190],
  [150, 190, 255],
  [240, 200, 120],
  [230, 140, 170],
  [170, 210, 140]
];
var DIGITS = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "?": ["111", "001", "011", "000", "010"],
  "\u2605": ["101", "111", "010", "111", "101"]
};
var cache3 = /* @__PURE__ */ new Map();
var TINT = {
  edit: [120, 170, 255],
  read: [110, 220, 235],
  run: [250, 180, 90],
  search: [200, 160, 250],
  agent: [160, 235, 150],
  think: [150, 160, 190]
};
function monitor(lit, frame2, seed = 0, kind = "think") {
  const key = `${lit ? 1 : 0}:${lit ? frame2 % 4 : 0}:${seed % 8}:${kind}`;
  const hit = cache3.get(key);
  if (hit) return hit;
  const grid = Array.from({ length: H }, () => new Array(W).fill(null));
  const put = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = c;
  };
  const box = (x, y, w, h, c) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c);
  };
  const WOOD = [138, 96, 62];
  const WOOD_DK = [104, 70, 44];
  box(0, 16, W, 8, WOOD);
  box(0, 16, W, 1, [168, 122, 82]);
  box(0, 23, W, 1, WOOD_DK);
  box(7, 12, 2, 3, BASE);
  box(5, 15, 6, 1, CASE);
  box(3, 18, 9, 3, [58, 62, 78]);
  box(4, 19, 7, 1, [92, 98, 118]);
  box(13, 18, 3, 3, [226, 118, 96]);
  put(12, 19, [226, 118, 96]);
  box(0, 19, 3, 2, [236, 234, 226]);
  box(1, 1, 14, 11, lit ? CASE_LIT : CASE);
  box(2, 2, 12, 9, DARK);
  if (lit) {
    const lens = [9, 6, 11, 7];
    for (let i = 0; i < 4; i++) {
      const y = 3 + i * 2;
      const wob = (frame2 + i * 3 + seed) % 5 - 2;
      const len = Math.max(2, Math.min(11, lens[i] + wob));
      const indent = i === 1 || i === 3 ? 3 : 2;
      for (let x = 0; x < len && indent + x < 13; x++) put(indent + x, y, i === 0 ? TINT[kind] : CODE[(i + seed) % CODE.length]);
    }
    if (frame2 % 2 === 0) put(3, 9, [250, 250, 250]);
  } else {
    for (let x = 3; x < 11; x++) put(x, 3, [40, 44, 58]);
  }
  const g = { w: W, h: H, grid };
  cache3.set(key, g);
  return g;
}
var badges = /* @__PURE__ */ new Map();
function badge(level, tier, face = "") {
  const key = level + ":" + tier.join("") + ":" + face;
  const hit = badges.get(key);
  if (hit) return hit;
  const grid = Array.from({ length: 16 }, () => new Array(16).fill(null));
  const put = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < 16 && y < 16) grid[y][x] = c;
  };
  const box = (x, y, w, h, c) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c);
  };
  const CARD = [238, 236, 228];
  const EDGE = [90, 92, 102];
  box(7, 0, 2, 2, EDGE);
  box(2, 2, 12, 13, EDGE);
  box(3, 3, 10, 3, tier);
  box(3, 6, 10, 8, CARD);
  const INK2 = [40, 42, 54];
  if (face) {
    const glyph = DIGITS[face] ?? DIGITS["0"];
    glyph.forEach((r, y) => [...r].forEach((c, x) => c === "1" && put(6 + x, 8 + y, INK2)));
  } else {
    const text = String(Math.max(1, Math.min(99, level)));
    const startX = text.length > 1 ? 4 : 6;
    [...text].forEach((ch, i) => {
      const glyph = DIGITS[ch] ?? DIGITS["0"];
      glyph.forEach((r, y) => [...r].forEach((c, x) => c === "1" && put(startX + i * 4 + x, 8 + y, INK2)));
    });
  }
  const g = { w: 16, h: 16, grid };
  badges.set(key, g);
  return g;
}

// src/nameplate.ts
var F6x13 = { w: 6, h: 13, g: {
  a: "00000000001c021e22261a0000",
  b: "00002020203c222222223c0000",
  c: "00000000001c222020221c0000",
  d: "00000202021e222222221e0000",
  e: "00000000001c223e20221c0000",
  f: "00000c1210103c101010100000",
  g: "00000000001c2222221e02221c",
  h: "00002020202c32222222220000",
  i: "000000080018080808081c0000",
  j: "00000004000c04040404242418",
  k: "00002020202428302824220000",
  l: "000018080808080808081c0000",
  m: "0000000000342a2a2a2a220000",
  n: "00000000002c32222222220000",
  o: "00000000001c222222221c0000",
  p: "00000000003c2222223c202020",
  q: "00000000001e2222221e020202",
  r: "00000000002c32202020200000",
  s: "00000000001c221804221c0000",
  t: "00000010103c101010120c0000",
  u: "000000000022222222261a0000",
  v: "00000000002222221414080000",
  w: "000000000022222a2a2a140000",
  x: "00000000002214080814220000",
  y: "0000000000222222261a02221c",
  z: "00000000003e040810203e0000",
  0: "00000814222222222214080000",
  1: "000008182808080808083e0000",
  2: "00001c222202040810203e0000",
  3: "00003e0204081c0202221c0000",
  4: "000004040c1414243e04040000",
  5: "00003e20202c320202221c0000",
  6: "00001c2220203c2222221c0000",
  7: "00003e02040408081010100000",
  8: "00001c2222221c2222221c0000",
  9: "00001c2222221e0202221c0000",
  "-": "0000000000003e000000000000",
  "_": "00000000000000000000003e00",
  ".": "000000000000000000081c0800"
} };
var F6x10 = { w: 6, h: 10, g: {
  a: "0000001c021e221e0000",
  b: "0020202c3222322c0000",
  c: "0000001c2220221c0000",
  d: "0002021a2622261a0000",
  e: "0000001c223e201c0000",
  f: "000c12103c1010100000",
  g: "0000001e22221e02221c",
  h: "0020202c322222220000",
  i: "000800180808081c0000",
  j: "0002000602020212120c",
  k: "00202022243824220000",
  l: "001808080808081c0000",
  m: "000000342a2a2a220000",
  n: "0000002c322222220000",
  o: "0000001c2222221c0000",
  p: "0000002c3222322c2020",
  q: "0000001a2622261a0202",
  r: "0000002c322020200000",
  s: "0000001c201c023c0000",
  t: "0010103c1010120c0000",
  u: "000000222222261a0000",
  v: "00000022221414080000",
  w: "00000022222a2a140000",
  x: "00000022140814220000",
  y: "0000002222261a02221c",
  z: "0000003e0408103e0000",
  0: "00081422222214080000",
  1: "000818280808083e0000",
  2: "001c22020c10203e0000",
  3: "003e02040c02221c0000",
  4: "00040c14243e04040000",
  5: "003e202c3202221c0000",
  6: "000c10202c32221c0000",
  7: "003e0204040810100000",
  8: "001c22221c22221c0000",
  9: "001c22261a0204180000",
  "-": "000000003e0000000000",
  "_": "00000000000000003e00",
  ".": "000000000000081c0800"
} };
var F5x8 = { w: 5, h: 8, g: {
  a: "0000000e12120e00",
  b: "0010101c12121c00",
  c: "0000000608080600",
  d: "0002020e12120e00",
  e: "0000000c16180c00",
  f: "00040a081c080800",
  g: "0000000c120e020c",
  h: "0010101c12121200",
  i: "0004000c04040e00",
  j: "0002000202020a04",
  k: "001010121c121200",
  l: "000c040404040e00",
  m: "0000001a15151500",
  n: "0000001c12121200",
  o: "0000000c12120c00",
  p: "0000001c121c1010",
  q: "0000000e120e0202",
  r: "000000141a101000",
  s: "000000060c020c00",
  t: "0008081c080a0400",
  u: "0000001212120e00",
  v: "0000000a0a0a0400",
  w: "0000001115150a00",
  x: "000000120c0c1200",
  y: "00000012120e120c",
  z: "0000001e04081e00",
  0: "00040a0a0a0a0400",
  1: "00040c0404040e00",
  2: "000c12020c101e00",
  3: "001e040c02120c00",
  4: "00040c141e040400",
  5: "001e101c02120c00",
  6: "000c101c12120c00",
  7: "001e020404080800",
  8: "000c120c12120c00",
  9: "000c12120e020c00",
  "-": "000000001e000000",
  "_": "000000000000001e",
  ".": "0000000000040e04"
} };
var F4x6 = { w: 4, h: 6, g: {
  a: "00060a0a0600",
  b: "080c0a0a0c00",
  c: "000608080600",
  d: "02060a0a0600",
  e: "00040a0c0600",
  f: "02040e040400",
  g: "00060a06020c",
  h: "080c0a0a0a00",
  i: "04000c040e00",
  j: "02000202020c",
  k: "080a0c0a0a00",
  l: "0c0404040e00",
  m: "000a0e0a0a00",
  n: "000c0a0a0a00",
  o: "00040a0a0400",
  p: "000c0a0c0808",
  q: "00060a0a0602",
  r: "000a0c080800",
  s: "00060c020c00",
  t: "040e04040200",
  u: "000a0a0a0600",
  v: "000a0a0a0400",
  w: "000a0a0e0a00",
  x: "000a04040a00",
  y: "000a0a06020c",
  z: "000e02040e00",
  0: "040a0e0a0400",
  1: "040c04040e00",
  2: "040a02040e00",
  3: "0e0204020c00",
  4: "0a0a0e020200",
  5: "0e080c020c00",
  6: "06080c0a0400",
  7: "0e0204080800",
  8: "060a040a0c00",
  9: "040a06020c00",
  "-": "00000e000000",
  "_": "00000000000e",
  ".": "000000000400"
} };
function rowBits(f, ch, y) {
  const s = f.g[ch];
  if (!s) return 0;
  return parseInt(s.slice(y * 2, y * 2 + 2), 16);
}
function word(f, s) {
  const w = s.length * f.w;
  const px = Array.from({ length: f.h }, () => new Array(w).fill(false));
  for (let i = 0; i < s.length; i++)
    for (let y = 0; y < f.h; y++) {
      const b = rowBits(f, s[i], y);
      for (let x = 0; x < f.w; x++) if (b & 1 << f.w - 1 - x) px[y][i * f.w + x] = true;
    }
  return { w, h: f.h, px };
}
function plate(f, s, wpx, hpx, bg, ink, border, scale = 1) {
  const grid = Array.from({ length: hpx }, () => new Array(wpx).fill(bg));
  if (border) {
    for (let x = 0; x < wpx; x++) {
      grid[0][x] = border;
      grid[hpx - 1][x] = border;
    }
    for (let y = 0; y < hpx; y++) {
      grid[y][0] = border;
      grid[y][wpx - 1] = border;
    }
  }
  const m = word(f, s);
  const dw = m.h * scale;
  const dh = m.w * scale;
  const ox = Math.floor((wpx - dw) / 2);
  const oy = Math.floor((hpx - dh) / 2);
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      if (!m.px[y][x]) continue;
      for (let j = 0; j < scale; j++)
        for (let i = 0; i < scale; i++) {
          const dx = ox + y * scale + j;
          const dy = oy + (m.w - 1 - x) * scale + i;
          if (dx >= 0 && dy >= 0 && dx < wpx && dy < hpx) grid[dy][dx] = ink;
        }
    }
  return { w: wpx, h: hpx, grid };
}
var LADDER = [F6x13, F6x10, F5x8, F4x6];
function band(f) {
  let top = f.h;
  let bot = -1;
  for (const s of Object.values(f.g))
    for (let y = 0; y < f.h; y++) {
      if (!parseInt(s.slice(y * 2, y * 2 + 2), 16)) continue;
      if (y < top) top = y;
      if (y > bot) bot = y;
    }
  return bot < top ? f.h : bot - top + 1;
}
var MIN_CHARS = 10;
var MAX_SCALE = 4;
var cut2 = (text, room) => text.length > room ? text.slice(0, room - 1) + "." : text;
var picks = /* @__PURE__ */ new Map();
function choose(text, wpx, hpx) {
  const key = `${text}\0${wpx}x${hpx}`;
  const held = picks.get(key);
  if (held !== void 0) return held;
  const fresh = pick(text, wpx, hpx);
  picks.set(key, fresh);
  return fresh;
}
function pick(text, wpx, hpx) {
  const cands = [];
  for (const font of LADDER) {
    const fits = Math.min(MAX_SCALE, Math.floor((wpx - 3) / band(font)));
    for (let scale = 1; scale <= fits; scale++) cands.push({ font, scale, room: Math.floor((hpx - 2) / (font.w * scale)), ink: band(font) * scale });
  }
  const thickest = (a, b) => b.ink - a.ink || b.font.h - a.font.h || b.room - a.room;
  const widest = (a, b) => b.room - a.room || b.ink - a.ink || b.font.h - a.font.h;
  const usable = cands.filter((c) => c.room >= 4);
  const thick = usable.filter((c) => c.scale >= 2);
  const floor = (
    // Enough letters to read: spend what is left on thickness.
    thick.filter((c) => c.room >= MIN_CHARS).sort(thickest)[0] ?? // Not enough letters at any size. Every option here is already 2px-stemmed,
    // so thickness has stopped being the scarce thing and length starts to pay.
    thick.sort(widest)[0] ?? // The strip is too narrow to double anything. 1:1 is a hairline that kitty's
    // filter greys out, but a faint name still beats no name.
    usable.sort(thickest)[0]
  );
  if (!floor) return null;
  const grown = thick.filter((c) => c.font === floor.font && c.scale > floor.scale && c.scale <= floor.scale + 1 && c.room >= text.length).sort(thickest)[0];
  const pick2 = grown ?? floor;
  return { font: pick2.font, text: cut2(text, pick2.room), scale: pick2.scale };
}

// src/render.ts
var INK = [32, 34, 46];
var NIGHT = [26, 28, 40];
var frameBuffer = null;
function buffer(bytes) {
  if (!frameBuffer || frameBuffer.length !== bytes) {
    frameBuffer = new Uint8ClampedArray(bytes);
    return frameBuffer;
  }
  frameBuffer.fill(0);
  return frameBuffer;
}
var LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
var PACK = LITTLE ? (v) => (4278190080 | (v & 255) << 16 | v & 65280 | v >> 16 & 255) >>> 0 : (v) => ((v & 16777215) << 8 | 255) >>> 0;
function renderRoom(cv2, scene, placed, sx, sy, frame2 = 2) {
  const w = cv2.w * sx;
  const h = cv2.rows * sy;
  const rgba = buffer(w * h * 4);
  const put = (x0, y0, bw, bh, c) => {
    for (let y = y0; y < y0 + bh; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = x0; x < x0 + bw; x++) {
        if (x < 0 || x >= w) continue;
        const i = (y * w + x) * 4;
        rgba[i] = c[0];
        rgba[i + 1] = c[1];
        rgba[i + 2] = c[2];
        rgba[i + 3] = 255;
      }
    }
  };
  const stamp = (g, x0, y0, boxW, boxH) => {
    for (let y = 0; y < boxH; y++) {
      const gy = Math.min(g.h - 1, Math.floor(y * g.h / boxH));
      for (let x = 0; x < boxW; x++) {
        const gx = Math.min(g.w - 1, Math.floor(x * g.w / boxW));
        const c = g.grid[gy][gx];
        if (!c) continue;
        const px2 = x0 + x;
        const py2 = y0 + y;
        if (px2 < 0 || py2 < 0 || px2 >= w || py2 >= h) continue;
        const i = (py2 * w + px2) * 4;
        rgba[i] = c[0];
        rgba[i + 1] = c[1];
        rgba[i + 2] = c[2];
        rgba[i + 3] = 255;
      }
    }
  };
  const py = sy / 2;
  const px = cv2.pixels();
  if (Number.isInteger(sx) && Number.isInteger(py)) {
    const u32 = new Uint32Array(rgba.buffer);
    for (let y = 0; y < cv2.h; y++) {
      const top = y * py;
      for (let x = 0; x < cv2.w; x++) {
        const v = px[y * cv2.w + x];
        if (v < 0) continue;
        const word2 = PACK(v);
        const left = x * sx;
        for (let by = 0; by < py; by++) {
          const from = (top + by) * w + left;
          for (let i = 0; i < sx; i++) u32[from + i] = word2;
        }
      }
    }
  } else {
    for (let y = 0; y < cv2.h; y++) {
      for (let x = 0; x < cv2.w; x++) {
        const c = cv2.get(x, y);
        if (c) put(x * sx, y * py, sx, py, c);
      }
    }
  }
  for (const pr of scene.props) {
    const size = PROP_SIZE[pr.kind];
    stamp(prop(pr.kind), pr.x * sx, pr.y * py, size.w * TILE * sx, size.h * TILE * py);
  }
  for (const m of scene.monitors) {
    stamp(monitor(m.lit, frame2, m.seed, m.kind), m.x * sx, m.y * py, MON_COLS * sx, MON_ROWS * sy);
  }
  for (const p of scene.plates) {
    const pick2 = choose(p.proj, PLATE_COLS * sx, PLATE_ROWS * sy);
    if (pick2) stamp(plate(pick2.font, pick2.text, PLATE_COLS * sx, PLATE_ROWS * sy, p.colour, INK, NIGHT, pick2.scale), p.x * sx, p.y * py, PLATE_COLS * sx, PLATE_ROWS * sy);
  }
  for (const b of scene.badges) {
    const tint = b.asking ? LOOK.needs.color : tierOf(b.level).color;
    stamp(badge(b.level, tint, b.asking ? "?" : ""), b.x * sx, b.y * py, TILE * sx, TILE * py);
  }
  for (const p of placed) {
    const g = frameOf(p.s.palette, p.s.hueShift, p.facing, p.pose, p.step, tierOf(p.s.level).color);
    stamp(g, p.x * sx, p.y * py, CHAR_W * sx, CHAR_H * py);
  }
  return { rgba, w, h };
}

// web/settings.ts
var DEFAULTS = { labels: "vertical", room: true };
var SETTINGS = [
  {
    key: "labels",
    label: "Project names",
    help: "Down the side of a desk takes far less width, so more projects fit before the room runs out.",
    options: [
      { value: "vertical", label: "Down the side" },
      { value: "horizontal", label: "Along the aisle" }
    ]
  },
  {
    key: "room",
    label: "Office",
    help: "Hiding it stops the animation as well, which is most of what this page costs a laptop battery.",
    options: [
      { value: true, label: "Shown" },
      { value: false, label: "Hidden" }
    ]
  }
];
var KEY = "guildhall.settings";
function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out = { ...DEFAULTS };
    for (const s of SETTINGS) {
      const v = raw[s.key];
      if (s.options.some((o) => o.value === v)) out[s.key] = v;
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}
var settings = read();
function mountSettings(button, panel, onChange) {
  for (const s of SETTINGS) {
    const group = document.createElement("div");
    group.className = "not-first:mt-4 not-first:border-t not-first:border-line not-first:pt-4";
    const name = document.createElement("span");
    name.className = "mb-1.5 block text-[0.82rem] text-label";
    name.id = `set-${s.key}`;
    name.textContent = s.label;
    const choices = document.createElement("div");
    choices.className = "flex flex-wrap gap-1.5";
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-labelledby", name.id);
    for (const o of s.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "flex-1 basis-32 cursor-pointer rounded border border-line bg-bg px-2 py-1.5 text-[0.78rem] text-muted hover:border-faint hover:text-label focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold aria-checked:border-gold aria-checked:bg-gold aria-checked:text-bg";
      b.setAttribute("role", "radio");
      b.textContent = o.label;
      const sync = () => b.setAttribute("aria-checked", String(settings[s.key] === o.value));
      sync();
      b.addEventListener("click", () => {
        ;
        settings[s.key] = o.value;
        try {
          localStorage.setItem(KEY, JSON.stringify(settings));
        } catch {
        }
        for (const el3 of choices.querySelectorAll("[role=radio]")) el3.setAttribute("aria-checked", "false");
        b.setAttribute("aria-checked", "true");
        onChange();
      });
      choices.append(b);
    }
    const help = document.createElement("p");
    help.className = "mt-1.5 mb-0 text-[0.72rem]/[1.4] text-faint";
    help.textContent = s.help;
    group.append(name, choices, help);
    panel.append(group);
  }
  const note = document.createElement("p");
  note.className = "mt-3.5 mb-0 border-t border-line pt-3 text-[0.72rem]/[1.4] text-faint";
  note.textContent = "Saved in this browser only. The terminal keeps its own settings.";
  panel.append(note);
  const open2 = (want) => {
    panel.hidden = !want;
    button.setAttribute("aria-expanded", String(want));
    if (want) panel.querySelector("[role=radio]")?.focus();
    else button.focus();
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    open2(panel.hidden);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== button) open2(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) open2(false);
  });
}

// web/room.ts
var roomEl;
var canvas;
var ctx2d;
var buffer2;
var bufferCtx;
var sessions = [];
var office = null;
var cv = null;
var sheetsReady = false;
var settled = false;
var setRoomSessions = (list) => sessions = list;
var relayout = () => cv = null;
async function loadSheets() {
  const imgs = [];
  for (let i = 0; i < 6; i++) {
    const bitmap = await createImageBitmap(await (await fetch(`/characters/char_${i}.png`)).blob());
    const off = new OffscreenCanvas(bitmap.width, bitmap.height);
    const c = off.getContext("2d");
    c.drawImage(bitmap, 0, 0);
    const d = c.getImageData(0, 0, bitmap.width, bitmap.height);
    imgs.push({ w: bitmap.width, h: bitmap.height, rgba: new Uint8ClampedArray(d.data) });
  }
  setSheets(imgs);
  sheetsReady = true;
}
function roomSize(n) {
  const cssW = roomEl.clientWidth || 900;
  const cols = Math.max(48, Math.min(104, Math.floor(cssW / 10)));
  const perBand = Math.max(1, Math.floor((cols - 6) / 8));
  const bands = Math.ceil(n / perBand) + 2;
  const tileRows = Math.max(24, Math.min(34, bands * 4 + 12));
  return { cols, rows: tileRows * 2 };
}
function ensureOffice(list) {
  const { cols, rows } = roomSize(list.length);
  if (!cv || cv.w !== cols || cv.rows !== rows) {
    cv = new Canvas(cols, rows * 2);
    office ??= new Office();
    office.fit(cv.w, cv.h, list);
  }
  office.assign(list);
  if (!settled && list.length) {
    settled = true;
    office.settle(list);
  }
  return office;
}
var last = performance.now();
var screenClock = 0;
var screenFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1e3, 0.25);
  last = now;
  if (!sheetsReady || roomEl.hidden || !sessions.length) return;
  const off = ensureOffice(sessions);
  off.update(dt, sessions);
  screenClock += dt;
  if (screenClock > 0.45) {
    screenClock = 0;
    screenFrame++;
  }
  off.vertical = settings.labels === "vertical";
  const placed = off.draw(cv, sessions);
  off.overlay(cv, placed, void 0, true);
  const scene = { props: off.props, monitors: off.monitors, badges: off.badges, plates: [] };
  const { rgba, w, h } = renderRoom(cv, scene, placed, 4, 8, screenFrame);
  if (buffer2.width !== w || buffer2.height !== h) {
    buffer2.width = w;
    buffer2.height = h;
  }
  bufferCtx.putImageData(new ImageData(rgba, w, h), 0, 0);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssW = roomEl.clientWidth;
  const cssH = Math.round(cssW * h / w);
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
    canvas.style.height = `${cssH}px`;
  }
  ctx2d.imageSmoothingEnabled = false;
  ctx2d.drawImage(buffer2, 0, 0, pxW, pxH);
  drawLabels(pxW, pxH);
}
function drawPlates(pxW, pxH) {
  const cw = pxW / cv.w;
  const ch = pxH / cv.rows;
  ctx2d.textBaseline = "middle";
  ctx2d.textAlign = "center";
  const w = PLATE_COLS * cw;
  const h = PLATE_ROWS * ch;
  const font = (px) => `${px}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const fits = (chars) => Math.min(w * 0.66, h * 0.94 / (chars * 0.62));
  const floor = fits(MIN_CHARS);
  for (const p of office.plates) {
    const x0 = p.x * cw;
    const y0 = p.y / 2 * ch;
    ctx2d.fillStyle = rgb(p.colour);
    ctx2d.fillRect(Math.floor(x0), Math.floor(y0), Math.ceil(w), Math.ceil(h));
    const size = Math.max(9, Math.floor(Math.min(fits(p.proj.length), floor * (4 / 3))));
    ctx2d.font = font(Math.max(size, Math.floor(floor)));
    let text = p.proj;
    while (text.length > 1 && ctx2d.measureText(text).width > h * 0.94) text = text.slice(0, -2) + "\u2026";
    ctx2d.save();
    ctx2d.translate(x0 + w / 2, y0 + h / 2);
    ctx2d.rotate(-Math.PI / 2);
    ctx2d.fillStyle = "#20222e";
    ctx2d.fillText(text, 0, 0);
    ctx2d.restore();
  }
}
function drawLabels(pxW, pxH) {
  if (office.vertical) drawPlates(pxW, pxH);
  const cw = pxW / cv.w;
  const ch = pxH / cv.rows;
  ctx2d.font = `${Math.max(9, Math.round(ch * 0.82))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx2d.textBaseline = "middle";
  ctx2d.textAlign = "center";
  for (let r = 0; r < cv.rows; r++) {
    for (let c = 0; c < cv.w; c++) {
      const cell = cv.cellAt(c, r);
      if (!cell) continue;
      if (cell.bg) {
        ctx2d.fillStyle = rgb(cell.bg);
        ctx2d.fillRect(Math.floor(c * cw), Math.floor(r * ch), Math.ceil(cw), Math.ceil(ch));
      }
      if (cell.ch.trim()) {
        ctx2d.fillStyle = rgb(cell.fg ?? [220, 220, 220]);
        ctx2d.fillText(cell.ch, c * cw + cw / 2, r * ch + ch / 2);
      }
    }
  }
}
function mountRoom(room, el3) {
  roomEl = room;
  canvas = el3;
  ctx2d = canvas.getContext("2d");
  buffer2 = document.createElement("canvas");
  bufferCtx = buffer2.getContext("2d");
  loadSheets().catch(() => {
    sheetsReady = false;
  });
  requestAnimationFrame(frame);
}

// web/links.ts
var URL_RE = /https?:\/\/[^\s'"`<>()[\]{}]+/g;
var TRAILING = /[.,;:!?)\]}>'"`]+$/;
function linkParts(text) {
  const out = [];
  URL_RE.lastIndex = 0;
  let at = 0;
  let m;
  while (m = URL_RE.exec(text)) {
    const href = m[0].replace(TRAILING, "");
    if (!href || !/^https?:\/\/[^/]/.test(href)) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: href, href });
    at = m.index + href.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

// web/terminal.ts
var KEY2 = "guildhall.control";
var WRAP = "guildhall.terminal.wrap";
var wrap = localStorage.getItem(WRAP) !== "exact";
var lastSig = "";
function repaintSoon() {
  lastSig = "";
}
var fullScreen = () => window.matchMedia("(max-width: 880px)").matches;
var openId = null;
var openName = "";
var timer = 0;
var el;
var onClose = () => {
};
var token = () => sessionStorage.getItem(KEY2) ?? "";
async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { "x-guildhall-control": token(), ...init.headers ?? {} } });
  const body = await res.json().catch(() => ({ error: "unreadable reply" }));
  return { status: res.status, ...body };
}
function askForToken(why) {
  clearInterval(timer);
  timer = 0;
  el.innerHTML = "";
  el.style.maxWidth = "";
  el.style.marginInline = "";
  el.append(titleBar(openName, "password needed"));
  const wrap2 = document.createElement("div");
  wrap2.className = "p-4";
  const h = document.createElement("p");
  h.className = "mt-0 mb-2 text-label";
  h.textContent = "Control password";
  const p = document.createElement("p");
  p.className = "mt-0 mb-3 text-[0.78rem]/[1.45] text-faint";
  p.textContent = `${why} It is the password you set on the machine running guildhall \u2014 press ? there, then c.`;
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "the password you set";
  input.className = "min-h-11 w-full rounded border border-line bg-bg px-2.5 py-2 font-mono text-[16px] text-label";
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "Unlock";
  go.className = "mt-2 cursor-pointer rounded border border-gold bg-gold px-3 py-1.5 font-bold text-bg";
  const submit = () => {
    sessionStorage.setItem(KEY2, input.value.trim());
    if (openId) show(openId, openName);
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  wrap2.append(h, p, input, go);
  el.append(wrap2);
  input.focus();
}
function titleBar(name, subtitle) {
  const bar2 = document.createElement("div");
  bar2.className = "flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2";
  const title = document.createElement("span");
  title.className = "truncate font-bold text-label";
  title.textContent = name;
  const live2 = document.createElement("span");
  live2.className = "shrink-0 text-[0.72rem] text-faint";
  live2.textContent = subtitle;
  const x = document.createElement("button");
  x.type = "button";
  x.textContent = "\u2715 Close";
  x.title = "Close the terminal (Esc)";
  x.className = "ml-auto flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot";
  x.addEventListener("click", close);
  bar2.append(title, live2, x);
  return bar2;
}
function chrome(name) {
  el.innerHTML = "";
  const bar2 = document.createElement("div");
  bar2.id = "screenbar";
  bar2.className = "flex items-center gap-2 border-b border-line bg-panel px-3 py-2";
  const title = document.createElement("span");
  title.className = "font-bold text-label";
  title.textContent = name;
  const live2 = document.createElement("span");
  live2.className = "text-[0.72rem] text-faint";
  live2.textContent = "live terminal";
  const mode = document.createElement("button");
  mode.type = "button";
  mode.id = "screenmode";
  mode.hidden = true;
  mode.className = "flex min-h-11 cursor-pointer items-center rounded border border-line bg-transparent px-3 text-[0.78rem] text-muted hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";
  const label = () => {
    mode.textContent = wrap ? "Wrapped" : "Exact";
    mode.title = wrap ? "Lines are reflowed to fit. Tap for the true grid." : "The true grid, scrolled sideways. Tap to reflow it to fit.";
  };
  label();
  mode.addEventListener("click", () => {
    wrap = !wrap;
    localStorage.setItem(WRAP, wrap ? "wrap" : "exact");
    label();
    repaintSoon();
    refresh();
  });
  const x = document.createElement("button");
  x.type = "button";
  x.textContent = "\u2715 Close";
  x.title = "Close the terminal (Esc)";
  x.className = "flex min-h-11 cursor-pointer items-center gap-1 rounded border border-hot bg-transparent px-3 text-[0.78rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot";
  x.addEventListener("click", close);
  const tail = document.createElement("div");
  tail.className = "ml-auto flex items-center gap-2";
  tail.append(mode, x);
  bar2.append(title, live2, tail);
  const pre = document.createElement("pre");
  pre.id = "screen";
  pre.className = "m-0 min-h-0 flex-1 overflow-auto overscroll-contain px-3 py-2 whitespace-pre";
  pre.textContent = "reading\u2026";
  const form = document.createElement("form");
  form.className = "flex gap-2 border-t border-line p-2";
  const input = document.createElement("input");
  input.id = "ask";
  input.autocomplete = "off";
  input.placeholder = "Type into this session\u2026";
  input.className = "min-h-11 flex-1 rounded border border-line bg-bg px-2.5 py-2 font-mono text-[16px] text-label";
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";
  send.className = "min-h-11 shrink-0 cursor-pointer rounded border border-gold bg-gold px-4 text-[15px] font-bold text-bg";
  form.append(input, send);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    send.disabled = true;
    const r = await api("/api/send", { method: "POST", body: JSON.stringify({ id: openId, text }) });
    send.disabled = false;
    if (r.error) {
      pre.textContent = `${r.error}

${pre.textContent}`;
      input.value = text;
    }
    refresh();
    input.focus();
  });
  el.append(bar2, pre, form);
  return { pre, input };
}
async function refresh() {
  if (!openId) return;
  const r = await api(`/api/screen?id=${encodeURIComponent(openId)}`);
  if (r.status === 401) return askForToken("That password was not accepted.");
  if (r.status === 403) return askForToken("Control is off, or this device is not on the machine or its tailnet.");
  if (r.status === 429) return askForToken("Too many wrong tries \u2014 wait a moment.");
  const pre = document.getElementById("screen");
  if (!pre) return;
  if (r.error) return void (pre.textContent = r.error);
  if (!r.render_grid) return;
  const sig = JSON.stringify(r.render_grid.row_spans);
  if (sig === lastSig && pre.childElementCount) return;
  lastSig = sig;
  paint(pre, r.render_grid);
}
var COMFORTABLE = 15;
var LEGIBLE = 8;
var READABLE = 12;
var PAD = 24;
var RULE = /^(\S)\1{7,}$/;
function fill(host, text) {
  const parts = linkParts(text);
  if (parts.length === 1 && !parts[0].href) return void host.append(text);
  for (const p of parts) {
    if (!p.href) {
      host.append(p.text);
      continue;
    }
    const a = document.createElement("a");
    a.href = p.href;
    a.textContent = p.text;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "underline decoration-dotted underline-offset-2 hover:decoration-solid";
    host.append(a);
  }
}
var ratio = 0;
function advanceRatio(host) {
  if (ratio) return ratio;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:100px";
  probe.textContent = "M".repeat(100);
  host.append(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  ratio = w > 0 ? w / 1e4 : 0.6;
  return ratio;
}
function paint(pre, g) {
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
  const byId = new Map(g.styles.map((st) => [st.id, st]));
  const rows = /* @__PURE__ */ new Map();
  for (const sp of g.row_spans) {
    const list = rows.get(sp.row) ?? [];
    list.push(sp);
    rows.set(sp.row, list);
  }
  pre.style.background = g.terminal_background ?? "transparent";
  pre.style.color = g.terminal_foreground ?? "inherit";
  el.style.maxWidth = "";
  el.style.marginInline = "";
  const advance = advanceRatio(pre);
  const usable = Math.max(200, pre.clientWidth - PAD);
  const exact = Math.min(COMFORTABLE, usable / (g.columns * advance));
  const cramped = exact < LEGIBLE;
  const reflow = wrap && cramped;
  const btn = document.getElementById("screenmode");
  if (btn) btn.hidden = !cramped;
  const size = reflow ? READABLE : Math.max(LEGIBLE, exact);
  pre.style.fontSize = `${size.toFixed(2)}px`;
  pre.style.lineHeight = "1.25";
  pre.style.whiteSpace = reflow ? "pre-wrap" : "pre";
  pre.style.overflowWrap = reflow ? "break-word" : "";
  if (fullScreen()) {
    pre.style.maxHeight = "";
  } else {
    const headerH = document.getElementById("bar")?.getBoundingClientRect().height ?? 0;
    const above = (el.firstElementChild?.getBoundingClientRect().height ?? 0) + headerH;
    const below = el.lastElementChild?.getBoundingClientRect().height ?? 0;
    pre.style.maxHeight = `${Math.max(200, window.innerHeight - above - below - 24)}px`;
  }
  const needed = Math.ceil(g.columns * advance * size) + PAD + 2;
  if (needed < pre.clientWidth) {
    el.style.maxWidth = `${needed}px`;
    el.style.marginInline = "auto";
  }
  const out = [];
  for (let r = 0; r < g.rows; r++) {
    const line = document.createElement("div");
    const spans = (rows.get(r) ?? []).sort((a, b) => a.column - b.column);
    let col = 0;
    for (const sp of spans) {
      if (sp.column > col) line.append(reflow ? "  ".slice(0, Math.min(2, sp.column - col)) : " ".repeat(sp.column - col));
      const st = byId.get(sp.style_id);
      const el3 = document.createElement("span");
      const fg = st?.inverse ? st?.background ?? g.terminal_background : st?.foreground;
      const bg = st?.inverse ? st?.foreground ?? g.terminal_foreground : st?.background;
      if (fg) el3.style.color = fg;
      if (bg && bg !== g.terminal_background) el3.style.background = bg;
      if (st?.bold) el3.style.fontWeight = "700";
      if (st?.faint) el3.style.opacity = "0.7";
      if (st?.italic) el3.style.fontStyle = "italic";
      if (st?.underline || st?.strikethrough) el3.style.textDecoration = `${st.underline ? "underline" : ""} ${st.strikethrough ? "line-through" : ""}`.trim();
      if (st?.invisible) el3.style.visibility = "hidden";
      if (reflow && RULE.test(sp.text)) el3.style.cssText += ";display:inline-block;width:100%;white-space:nowrap;overflow:hidden;vertical-align:bottom";
      fill(el3, sp.text);
      line.append(el3);
      col = sp.column + [...sp.text].length;
    }
    if (!spans.length) line.append("\xA0");
    out.push(line);
  }
  pre.replaceChildren(...out);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
function show(id, name) {
  openId = id;
  openName = name;
  el.hidden = false;
  document.body.classList.add("overflow-hidden");
  if (!token()) return askForToken("This is behind a separate password from the passcode.");
  const { input } = chrome(name);
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 2e3);
  if (!fullScreen()) input.focus();
}
function close() {
  openId = null;
  clearInterval(timer);
  timer = 0;
  el.hidden = true;
  el.innerHTML = "";
  el.style.maxWidth = "";
  el.style.marginInline = "";
  document.body.classList.remove("overflow-hidden");
  onClose();
}
function mountTerminal(host, closed) {
  el = host;
  onClose = closed;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openId) close();
  });
  let t = 0;
  addEventListener("resize", () => {
    if (!openId) return;
    clearTimeout(t);
    t = setTimeout(() => {
      repaintSoon();
      refresh();
    }, 120);
  });
}
var isOpen = () => openId !== null;

// web/press.ts
var DEPLOYS = "guildhall.press.deploys";
var LOCAL_WAIT = 2e4;
var FULL_WAIT = 1e5;
var el2;
var timer2 = 0;
var open = false;
var settled2 = false;
var deploys = localStorage.getItem(DEPLOYS) === "1";
var onClose2 = () => {
};
function hue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `oklch(0.82 0.13 ${h})`;
}
function ciLook(ci) {
  if (ci.status !== "completed") return { glyph: "\u25D4", tone: "text-gold", say: `${ci.workflow} ${ci.status}` };
  switch (ci.conclusion) {
    case "success":
      return { glyph: "\u2714", tone: "text-ok", say: `${ci.workflow} passed` };
    case "failure":
    case "timed_out":
      return { glyph: "\u2716", tone: "text-hot", say: `${ci.workflow} ${ci.conclusion === "failure" ? "failed" : "timed out"}` };
    case "cancelled":
    case "skipped":
      return { glyph: "\u2298", tone: "text-faint", say: `${ci.workflow} ${ci.conclusion}` };
    default:
      return { glyph: "\xB7", tone: "text-faint", say: `${ci.workflow} ${ci.conclusion ?? ci.status}` };
  }
}
var MARK = {
  commit: { glyph: "\u25CF", tone: "text-ok" },
  push: { glyph: "\u21E7", tone: "text-gold" },
  run: { glyph: "\u2699", tone: "text-muted" },
  deploy: { glyph: "\u2601", tone: "text-ok" }
};
function describe(i) {
  if (i.kind === "commit") return i.subject;
  if (i.kind === "push") return `pushed ${i.branch} \u2192 ${i.remote}${i.forced ? "  \xB7  forced" : ""}${i.count ? `  \xB7  ${i.count} commit${i.count === 1 ? "" : "s"}` : ""}`;
  if (i.kind === "run") return `${i.workflow}  \xB7  ${i.conclusion ?? i.status}`;
  return `deployed ${i.hostname ?? i.worker}${i.env ? `  \xB7  ${i.env}` : ""}  \xB7  via ${i.source}`;
}
var failed = (i) => i.kind === "run" && (i.conclusion === "failure" || i.conclusion === "timed_out");
function repoRow(r) {
  const li = document.createElement("li");
  li.className = "flex items-baseline gap-2 px-2 py-[0.15rem] whitespace-nowrap hover:bg-line/40";
  const tint = hue(r.label);
  const bar2 = document.createElement("span");
  bar2.textContent = "\u2502";
  bar2.style.color = tint;
  const name = document.createElement("span");
  name.className = "w-[9rem] shrink-0 truncate font-bold max-[560px]:w-[6.5rem]";
  name.style.color = tint;
  name.textContent = r.label;
  if (r.error) {
    const err = document.createElement("span");
    err.className = "truncate text-hot";
    err.textContent = r.error;
    li.append(bar2, name, err);
    return li;
  }
  const branch = document.createElement("span");
  branch.className = "w-[7rem] shrink-0 truncate text-faint max-[720px]:hidden";
  branch.textContent = r.branch ?? "";
  const sync = document.createElement("span");
  sync.className = `w-[4.5rem] shrink-0 tabular-nums ${r.ahead ? "font-bold text-gold" : "text-faint"}`;
  sync.textContent = [r.ahead ? `\u2191${r.ahead}` : "", r.behind ? `\u2193${r.behind}` : ""].filter(Boolean).join(" ");
  if (r.ahead) sync.title = `${r.ahead} commit${r.ahead === 1 ? "" : "s"} not pushed anywhere`;
  const work = document.createElement("span");
  work.className = `w-[4.5rem] shrink-0 tabular-nums ${r.changed ? "text-gold" : "text-faint"}`;
  work.textContent = [r.changed ? `\u25CF${r.changed}` : "", r.untracked ? `?${r.untracked}` : ""].filter(Boolean).join(" ");
  if (r.changed || r.untracked) work.title = `${r.changed} changed, ${r.untracked} untracked`;
  const ci = document.createElement("span");
  ci.className = "w-4 shrink-0 text-center";
  if (r.ci) {
    const look = ciLook(r.ci);
    ci.textContent = look.glyph;
    ci.className += ` ${look.tone}`;
    ci.title = look.say;
  }
  const live2 = document.createElement("span");
  live2.className = "w-4 shrink-0 text-center";
  if (r.live) {
    live2.textContent = r.live.rollback ? "\u21BA" : "\u2601";
    live2.className += r.live.rollback ? " text-gold" : " text-ok";
    live2.title = `${r.live.rollback ? "rolled back" : "live"}: ${r.live.hostname ?? r.live.worker}`;
  }
  const when = document.createElement("span");
  when.className = "ml-auto shrink-0 tabular-nums text-faint";
  when.textContent = r.lastCommitAt ? ago(Date.now() - r.lastCommitAt) : "";
  li.append(bar2, name, branch, sync, work, ci, live2, when);
  if (!r.upstream && !r.unborn) {
    const note = document.createElement("span");
    note.className = "shrink-0 pl-2 text-faint max-[560px]:hidden";
    note.textContent = "no upstream";
    li.append(note);
  }
  return li;
}
function feedRow(i) {
  const li = document.createElement("li");
  li.className = "flex items-baseline gap-2 px-2 py-[0.15rem] whitespace-nowrap hover:bg-line/40";
  const mark = MARK[i.kind];
  const tint = hue(i.repo);
  const glyph = document.createElement("span");
  glyph.className = `w-3 shrink-0 text-center ${mark.tone}`;
  glyph.textContent = mark.glyph;
  glyph.title = i.kind;
  const when = document.createElement("span");
  when.className = "w-[2.6rem] shrink-0 text-right tabular-nums text-faint";
  when.textContent = ago(Date.now() - i.at);
  const bar2 = document.createElement("span");
  bar2.textContent = "\u2502";
  bar2.style.color = tint;
  const repo = document.createElement("span");
  repo.className = "w-[9rem] shrink-0 truncate max-[560px]:w-[6.5rem]";
  repo.style.color = tint;
  repo.textContent = i.repo;
  const sha = document.createElement("span");
  sha.className = "w-[4.5rem] shrink-0 tabular-nums text-faint max-[720px]:hidden";
  sha.textContent = i.kind === "deploy" ? "" : i.short;
  const what = document.createElement("span");
  what.className = `truncate ${failed(i) ? "text-hot" : i.kind === "commit" ? "text-label" : "text-muted"}`;
  what.textContent = describe(i);
  li.append(glyph, when, bar2, repo, sha, what);
  return li;
}
function heading(text, count) {
  const h = document.createElement("div");
  h.className = "sticky top-0 z-[1] flex items-center gap-2 bg-panel px-2 py-1 text-[0.72rem] tracking-[0.14em] text-gold uppercase";
  const label = document.createElement("span");
  label.textContent = count === void 0 ? text : `${text} ${count}`;
  const rule = document.createElement("span");
  rule.className = "h-px flex-1 bg-line";
  h.append(label, rule);
  return h;
}
function render(snap) {
  const wrap2 = document.createElement("div");
  wrap2.className = "flex h-full min-h-0 flex-col";
  const bar2 = document.createElement("div");
  bar2.className = "flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2";
  const title = document.createElement("span");
  title.className = "font-bold tracking-[0.06em] text-gold";
  title.textContent = "PRESSROOM";
  const meta = document.createElement("span");
  meta.className = "truncate text-[0.72rem] text-faint";
  meta.textContent = snap.error ? "" : `${snap.repos.length} repos \xB7 ${ago(Date.now() - snap.at)}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = deploys ? "deploys on" : "+ deploys";
  toggle.title = deploys ? "Reading GitHub Actions and Cloudflare too" : "Also read workflow runs and Cloudflare deploys (~17s the first time)";
  toggle.className = `ml-auto flex min-h-9 shrink-0 cursor-pointer items-center rounded border px-2.5 text-[0.72rem] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${deploys ? "border-gold text-gold" : "border-line text-muted hover:text-label"}`;
  toggle.addEventListener("click", () => {
    deploys = !deploys;
    localStorage.setItem(DEPLOYS, deploys ? "1" : "0");
    refresh2();
  });
  const x = document.createElement("button");
  x.type = "button";
  x.textContent = "\u2715 Close";
  x.title = "Close (Esc)";
  x.className = "flex min-h-9 shrink-0 cursor-pointer items-center rounded border border-hot bg-transparent px-2.5 text-[0.72rem] font-bold text-hot hover:bg-hot hover:text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hot";
  x.addEventListener("click", close2);
  bar2.append(title, meta, toggle, x);
  wrap2.append(bar2);
  const body = document.createElement("div");
  body.className = "min-h-0 flex-1 overflow-auto overscroll-contain text-[0.78rem]/[1.5]";
  if (snap.error) {
    const p = document.createElement("p");
    p.className = "m-0 px-2.5 py-8 text-center text-muted";
    p.textContent = snap.error;
    body.append(p);
  } else if (!snap.repos.length && !snap.items.length) {
    const p = document.createElement("p");
    p.className = "m-0 px-2.5 py-8 text-center text-faint";
    p.textContent = snap.loading ? deploys ? "Reading \u2014 deploys take about 17 seconds." : "Reading\u2026" : "Nothing to show.";
    body.append(p);
  } else {
    if (snap.stale) {
      const note = document.createElement("p");
      note.className = "m-0 border-b border-gold/40 bg-gold/10 px-2.5 py-1.5 text-[0.72rem] text-gold";
      note.textContent = snap.stale;
      body.append(note);
    }
    const busy = snap.stale ? [] : snap.repos.filter((r) => r.ahead || r.changed || r.untracked || r.error);
    const quiet = snap.stale ? [] : snap.repos.filter((r) => !(r.ahead || r.changed || r.untracked || r.error));
    if (!snap.stale) {
      body.append(heading("unpushed & dirty", busy.length));
      if (busy.length) {
        const ul = document.createElement("ul");
        ul.className = "m-0 list-none p-0";
        for (const r of busy) ul.append(repoRow(r));
        body.append(ul);
      } else {
        const p = document.createElement("p");
        p.className = "m-0 px-2.5 py-2 text-faint";
        p.textContent = "Everything is pushed and clean.";
        body.append(p);
      }
    }
    if (quiet.length) {
      const details2 = document.createElement("details");
      const sum = document.createElement("summary");
      sum.className = "cursor-pointer px-2 py-1 text-[0.72rem] text-faint hover:text-label";
      sum.textContent = `${quiet.length} clean ${quiet.length === 1 ? "repo" : "repos"}`;
      const ul = document.createElement("ul");
      ul.className = "m-0 list-none p-0";
      for (const r of quiet) ul.append(repoRow(r));
      details2.append(sum, ul);
      body.append(details2);
    }
    body.append(heading("feed", snap.items.length));
    if (snap.local) {
      const note = document.createElement("p");
      note.className = "m-0 px-2.5 py-1 text-[0.72rem] text-faint";
      note.textContent = "Commits and pushes only \u2014 deploys were not read.";
      body.append(note);
    }
    for (const err of [snap.githubError, snap.cloudflareError]) {
      if (!err) continue;
      const p = document.createElement("p");
      p.className = "m-0 px-2.5 py-1 text-[0.72rem] text-hot";
      p.textContent = err;
      body.append(p);
    }
    const feed2 = document.createElement("ul");
    feed2.className = "m-0 list-none p-0";
    for (const i of snap.items) feed2.append(feedRow(i));
    body.append(feed2);
  }
  wrap2.append(body);
  el2.replaceChildren(wrap2);
}
function normalise(snap) {
  return {
    at: typeof snap?.at === "number" ? snap.at : Date.now(),
    items: Array.isArray(snap?.items) ? snap.items : [],
    repos: Array.isArray(snap?.repos) ? snap.repos : [],
    local: !!snap?.local,
    githubError: snap?.githubError ?? void 0,
    cloudflareError: snap?.cloudflareError ?? void 0,
    error: snap?.error ?? void 0,
    loading: !!snap?.loading,
    // A note, deliberately not an error: the feed is the same in both versions and
    // is worth drawing. Saying "the server is older" and then showing nothing
    // would throw away the half that works.
    stale: Array.isArray(snap?.repos) ? void 0 : "The machine is running an older guildhall \u2014 restart it for the repo panel. The feed below is current."
  };
}
async function refresh2() {
  if (!open) return;
  let snap;
  try {
    const res = await fetch(`/api/press${deploys ? "?deploys=1" : ""}`, { signal: AbortSignal.timeout(deploys ? FULL_WAIT : LOCAL_WAIT) });
    if (!res.ok) return render({ at: Date.now(), items: [], repos: [], local: true, error: res.status === 401 ? "The passcode changed \u2014 reload to sign in again." : `the server said ${res.status}` });
    snap = await res.json();
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return render({ at: Date.now(), items: [], repos: [], local: true, error: timedOut ? "guildhall did not answer in time \u2014 the machine may be asleep." : "could not reach guildhall" });
  }
  const shaped = normalise(snap);
  try {
    render(shaped);
  } catch (e) {
    render({ at: Date.now(), items: [], repos: [], local: true, error: `could not draw this: ${e instanceof Error ? e.message : "unknown error"}` });
  }
  if (shaped.loading) {
    clearInterval(timer2);
    timer2 = setInterval(refresh2, 1200);
  } else if (settled2 !== true) {
    settled2 = true;
    clearInterval(timer2);
    timer2 = setInterval(refresh2, 6e4);
  }
}
function show2() {
  open = true;
  settled2 = false;
  el2.hidden = false;
  document.body.classList.add("overflow-hidden");
  render({ at: Date.now(), items: [], repos: [], local: !deploys });
  refresh2();
  clearInterval(timer2);
  timer2 = setInterval(refresh2, 3e4);
}
function close2() {
  open = false;
  clearInterval(timer2);
  timer2 = 0;
  el2.hidden = true;
  el2.replaceChildren();
  document.body.classList.remove("overflow-hidden");
  onClose2();
}
var isOpen2 = () => open;
function mountPress(host, closed) {
  el2 = host;
  onClose2 = closed;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) close2();
  });
}

// web/app.ts
var bar = { counts: $("#counts"), link: $("#link"), ver: $("#ver") };
var roomEl2 = $("#room");
var stampEl = $("#stamp");
var offlineEl = $("#offline");
var sessions2 = [];
var seenAt = 0;
var live = false;
function setLink(state) {
  const dot = document.createElement("span");
  dot.className = `text-[0.9rem]/none ${state === "live" ? "text-ok" : "text-hot"}`;
  dot.textContent = state === "live" ? "\u25CF" : "\u25CB";
  const word2 = document.createElement("span");
  word2.className = "max-[560px]:hidden";
  word2.textContent = state;
  bar.link.replaceChildren(dot, word2);
}
function paintCounts(list) {
  const counts = {};
  for (const s of list) counts[s.state] = (counts[s.state] ?? 0) + 1;
  bar.counts.replaceChildren(
    ...["error", "needs", "working", "shell", "review", "done", "parked"].filter((k) => counts[k]).map((k) => {
      const el3 = document.createElement("span");
      el3.style.color = rgb(LOOK[k].color);
      el3.className = "whitespace-nowrap";
      el3.textContent = `${LOOK[k].glyph} `;
      const n = document.createElement("span");
      n.className = "text-label";
      n.textContent = String(counts[k]);
      const word2 = document.createElement("span");
      word2.className = "text-label";
      word2.textContent = ` ${LOOK[k].label}`;
      el3.title = `${counts[k]} ${LOOK[k].label}`;
      el3.append(n, word2);
      return el3;
    })
  );
}
var clientStamp = null;
function apply(data) {
  if (data.client) {
    if (clientStamp === null) clientStamp = data.client;
    else if (data.client !== clientStamp && !isOpen() && !isOpen2()) return void location.reload();
  }
  sessions2 = data.sessions;
  setRoomSessions(sessions2);
  if (data.version) {
    const [num, commit] = data.version.split(" \xB7 ");
    const build = document.createElement("span");
    build.className = "build";
    build.textContent = commit ? ` \xB7 ${commit}` : "";
    bar.ver.replaceChildren((data.update ? "\u21E1 v" : "v") + num, build);
    bar.ver.classList.toggle("newer", !!data.update);
    bar.ver.title = data.update ? `v${data.update} is available` : "";
  }
  showRoom();
  paintCounts(sessions2);
  paintList(sessions2);
  seenAt = Date.now();
  freshness();
}
function freshness() {
  if (!seenAt) return;
  const age = Date.now() - seenAt;
  const n = sessions2.length;
  const when = age < 6e4 ? "moments ago" : `${ago(age)} ago`;
  stampEl.textContent = `${n} session${n === 1 ? "" : "s"} \xB7 updated ${when}`;
  const stale = !live && age > 2e4;
  document.body.classList.toggle("stale", stale);
  offlineEl.hidden = !stale;
  if (stale) offlineEl.textContent = `Not receiving updates \u2014 the machine is asleep or unreachable. This is how it looked ${when}.`;
}
function connect() {
  let es = null;
  let delay = 1e3;
  let timer3 = 0;
  const retry = () => {
    clearTimeout(timer3);
    timer3 = setTimeout(probe, delay);
    delay = Math.min(delay * 2, 3e4);
  };
  const probe = async () => {
    try {
      const r = await fetch("/api/sessions", { cache: "no-store" });
      if (r.status === 401) return location.reload();
      return open2();
    } catch {
    }
    retry();
  };
  function open2() {
    es?.close();
    delay = 1e3;
    es = new EventSource("/api/stream");
    es.onopen = () => {
      live = true;
      setLink("live");
      freshness();
    };
    es.onmessage = (e) => {
      live = true;
      apply(JSON.parse(e.data));
    };
    es.onerror = () => {
      live = false;
      setLink("offline");
      es?.close();
      es = null;
      freshness();
      retry();
    };
  }
  open2();
  return { probe: () => (delay = 1e3, probe()) };
}
function showRoom() {
  roomEl2.hidden = window.innerWidth <= 720 || !settings.room || sessions2.length === 0;
}
mountTerminal($("#terminal"), () => {
});
var pressBtn = $("#pressbtn");
mountPress($("#press"), () => pressBtn.setAttribute("aria-expanded", "false"));
pressBtn.addEventListener("click", () => {
  const opening = !isOpen2();
  opening ? show2() : close2();
  pressBtn.setAttribute("aria-expanded", String(opening));
});
mountList($("#list"), $("#empty"), show);
mountRoom(roomEl2, $("#canvas"));
mountSettings($("#gear"), $("#settings"), () => {
  showRoom();
  relayout();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  freshness();
  if (!live) feed.probe();
});
addEventListener("resize", () => {
  showRoom();
  relayout();
});
var feed = connect();
setInterval(freshness, 1e3);
