const { useEffect, useMemo, useRef, useState } = React;

const regions = Array.from({ length: 35 }, (_, index) => {
  const regionX = (index % 7) - 3;
  const regionZ = Math.floor(index / 7) - 2;
  const chunks = Array.from({ length: 1024 }, (_, slot) => ({
    x: slot % 32,
    z: Math.floor(slot / 32),
    occupied: ((slot * 17 + index * 31) % 11) < 7,
    invalid: (slot + index * 13) % 173 === 0
  })).filter((chunk) => chunk.occupied);
  return { id: `${regionX}:${regionZ}`, regionX, regionZ, chunks };
});

function App() {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const [camera, setCamera] = useState(() => JSON.parse(localStorage.getItem("map-camera") || "null") || { x: 180, y: 160, scale: 4.5 });
  const [selectedRegion, setSelectedRegion] = useState("0:0");
  const [selectedChunks, setSelectedChunks] = useState(new Set(["6:9", "7:9", "7:10"]));
  const [hover, setHover] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState("chunks");
  const selected = useMemo(() => regions.find((region) => region.id === selectedRegion), [selectedRegion]);

  useEffect(() => localStorage.setItem("map-camera", JSON.stringify(camera)), [camera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const render = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const context = canvas.getContext("2d");
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#101416";
      context.fillRect(0, 0, rect.width, rect.height);
      regions.forEach((region) => drawRegion(context, region, camera, selectedRegion, selectedChunks, mode));
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [camera, selectedRegion, selectedChunks, mode]);

  const locate = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const chunkX = Math.floor((clientX - rect.left - camera.x) / camera.scale);
    const chunkZ = Math.floor((clientY - rect.top - camera.y) / camera.scale);
    const regionX = Math.floor(chunkX / 32);
    const regionZ = Math.floor(chunkZ / 32);
    return { chunkX, chunkZ, regionX, regionZ, localX: chunkX - regionX * 32, localZ: chunkZ - regionZ * 32 };
  };

  const zoomAt = (scale, screenX, screenY) => setCamera((current) => {
    const next = Math.min(24, Math.max(.2, scale));
    const worldX = (screenX - current.x) / current.scale;
    const worldZ = (screenY - current.y) / current.scale;
    return { x: screenX - worldX * next, y: screenY - worldZ * next, scale: next };
  });

  const fit = () => {
    const rect = wrapRef.current.getBoundingClientRect();
    const scale = Math.min((rect.width - 80) / 224, (rect.height - 80) / 160);
    setCamera({ x: rect.width / 2, y: rect.height / 2, scale });
  };

  const centerRegion = (id) => {
    const region = regions.find((item) => item.id === id);
    const rect = wrapRef.current.getBoundingClientRect();
    setSelectedRegion(id);
    setSelectedChunks(new Set());
    setCamera((current) => ({ x: rect.width / 2 - (region.regionX * 32 + 16) * Math.max(current.scale, 5), y: rect.height / 2 - (region.regionZ * 32 + 16) * Math.max(current.scale, 5), scale: Math.max(current.scale, 5) }));
  };

  const clickMap = (event) => {
    if (dragRef.current?.moved) return;
    const point = locate(event.clientX, event.clientY);
    const region = regions.find((item) => item.regionX === point.regionX && item.regionZ === point.regionZ);
    if (!region) return;
    if (region.id !== selectedRegion) { setSelectedRegion(region.id); setSelectedChunks(new Set()); }
    const occupied = region.chunks.some((chunk) => chunk.x === point.localX && chunk.z === point.localZ);
    if (occupied && event.shiftKey) setSelectedChunks((current) => {
      const next = new Set(region.id === selectedRegion ? current : []);
      const key = `${point.localX}:${point.localZ}`;
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  return <main className="page"><section className="window" role="dialog" aria-label="地图工作台导航原型">
    <header className="header"><div><p className="eyebrow">MCA / MAP WORKBENCH</p><h1>地图工作台</h1><p className="sub">server-survival-01 · 只读预览 / 受保护变更</p></div><span className="status">● stopped · 可执行变更</span></header>
    <div className="main">
      <section className="map-panel">
        <div className="toolbar"><div className="toolbar-title"><strong>世界区块地图</strong><small>{regions.length} MCA · OVERWORLD</small></div><select value={selectedRegion} onChange={(event) => centerRegion(event.target.value)} aria-label="定位 MCA 区域">{regions.map((region) => <option key={region.id} value={region.id}>{region.regionX},{region.regionZ} · r.{region.regionX}.{region.regionZ}.mca</option>)}</select><div className="zoom"><button onClick={() => zoomAt(camera.scale / 1.35, wrapRef.current.clientWidth / 2, wrapRef.current.clientHeight / 2)} aria-label="缩小">−</button><output>{Math.round(camera.scale * 25)}%</output><button onClick={() => zoomAt(camera.scale * 1.35, wrapRef.current.clientWidth / 2, wrapRef.current.clientHeight / 2)} aria-label="放大">+</button><button onClick={fit}>适配</button></div></div>
        <div ref={wrapRef} className="canvas-wrap"><canvas ref={canvasRef} tabIndex="0" className={dragging ? "dragging" : ""} aria-label="可拖拽和缩放的世界区块地图" onPointerDown={(event) => { dragRef.current = { x: event.clientX, y: event.clientY, camera, moved: false }; setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const point = locate(event.clientX, event.clientY); setHover(point); if (!dragRef.current) return; const dx = event.clientX - dragRef.current.x; const dy = event.clientY - dragRef.current.y; if (Math.hypot(dx, dy) > 4) dragRef.current.moved = true; setCamera({ ...dragRef.current.camera, x: dragRef.current.camera.x + dx, y: dragRef.current.camera.y + dy }); }} onPointerUp={(event) => { clickMap(event); dragRef.current = null; setDragging(false); }} onPointerLeave={() => setHover(null)} onWheel={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); zoomAt(camera.scale * Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * .0025), event.clientX - rect.left, event.clientY - rect.top); }} /><div className="legend"><span>已占用</span><span className="selected">已选择</span><span className="invalid">异常</span></div></div>
        <div className="coords"><code>{hover ? `区块 X ${hover.chunkX} · Z ${hover.chunkZ} · MCA ${hover.regionX},${hover.regionZ}` : `MCA ${selectedRegion}`}</code><span>拖动平移 · 滚轮缩放 · Shift 点击选择</span></div>
      </section>
      <aside className="rail"><div className="rail-head"><span>操作面板</span><strong>高危</strong></div><p>浏览可跨越多个 MCA 区域。删除范围始终锁定当前区域，切换区域会清空旧选择。</p><div className="modes">{[["chunks","已选择区块"],["rectangle","矩形区域"],["region","整个 MCA 区域"]].map(([value,label]) => <label key={value} className={`mode ${mode === value ? "active" : ""}`}><input type="radio" checked={mode === value} onChange={() => setMode(value)} />{label}</label>)}</div><p className="impact">当前区域：<strong>{selected?.regionX},{selected?.regionZ}</strong><br />当前影响：<strong>{mode === "region" ? "整个区域" : `${selectedChunks.size} 个区块`}</strong></p><button className="danger" disabled={mode === "chunks" && !selectedChunks.size}>生成删除计划</button><button>管理快照 · 6</button></aside>
    </div><footer className="footer"><span>只读预览 · 停服门禁 · 自动快照 · 精确确认</span><span>导航原型</span></footer>
  </section></main>;
}

function drawRegion(context, region, camera, selectedRegion, selectedChunks, mode) {
  const x = camera.x + region.regionX * 32 * camera.scale;
  const y = camera.y + region.regionZ * 32 * camera.scale;
  const size = 32 * camera.scale;
  if (x > context.canvas.width || y > context.canvas.height || x + size < 0 || y + size < 0) return;
  const selected = region.id === selectedRegion;
  context.fillStyle = selected ? "rgba(102,194,219,.13)" : "rgba(102,194,219,.055)";
  context.fillRect(x, y, size, size);
  if (camera.scale > .8) region.chunks.forEach((chunk) => { context.fillStyle = chunk.invalid ? "#db6656" : "rgba(102,194,219,.68)"; context.fillRect(x + chunk.x * camera.scale + .4, y + chunk.z * camera.scale + .4, Math.max(.8, camera.scale - .8), Math.max(.8, camera.scale - .8)); });
  if (selected) { context.fillStyle = "rgba(240,201,124,.5)"; selectedChunks.forEach((key) => { const [cx, cz] = key.split(":").map(Number); context.fillRect(x + cx * camera.scale, y + cz * camera.scale, camera.scale, camera.scale); }); if (mode === "region") { context.fillStyle = "rgba(240,201,124,.12)"; context.fillRect(x, y, size, size); } }
  context.strokeStyle = selected ? "#c9f1fb" : "rgba(102,194,219,.35)"; context.lineWidth = selected ? 2 : 1; context.strokeRect(x + .5, y + .5, size - 1, size - 1);
  if (size > 54) { const label = region.id.replace(":", ","); context.font = "11px IBM Plex Mono, monospace"; context.fillStyle = "rgba(16,20,22,.85)"; context.fillRect(x + 5, y + 5, context.measureText(label).width + 10, 20); context.fillStyle = selected ? "#c9f1fb" : "#aebabe"; context.fillText(label, x + 10, y + 19); }
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
