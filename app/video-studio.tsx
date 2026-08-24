"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditSettings, FootballMoment, JobStage } from "@/lib/video/types";
import { buildPreviewMoments, packTimeline } from "@/lib/video/ranking";

type View = "upload" | "processing" | "result";
type AudioMode = EditSettings["originalAudio"];
type Intensity = EditSettings["intensity"];

const stages: { key: JobStage; label: string; detail: string }[] = [
  { key: "uploaded", label: "Uploading", detail: "Securing your source footage" },
  { key: "analyzing", label: "Analyzing football", detail: "Scanning the entire match" },
  { key: "detecting_moments", label: "Finding key moments", detail: "Goals, chances, saves and skills" },
  { key: "tracking", label: "Tracking players & ball", detail: "Building a dynamic vertical crop" },
  { key: "generating_commentary", label: "Creating commentary", detail: "Writing visible, evidence-based analysis" },
  { key: "editing", label: "Editing", detail: "Pacing, captions and emphasis" },
  { key: "rendering", label: "Rendering", detail: "Composing one 9:16 MP4" },
];

export function VideoStudio() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(65);
  const [commentary, setCommentary] = useState(true);
  const [highlight, setHighlight] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [audio, setAudio] = useState<AudioMode>("reduced");
  const [intensity, setIntensity] = useState<Intensity>("dynamic");
  const [stageIndex, setStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [moments, setMoments] = useState<FootballMoment[]>([]);

  const selected = useMemo(() => moments.filter((moment) => moment.selectedForFinalVideo), [moments]);
  const finalDuration = selected.reduce((sum, moment) => sum + moment.endTime - moment.startTime, 0);

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  useEffect(() => {
    if (view !== "processing") return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = current + 1;
        const nextStage = Math.min(stages.length - 1, Math.floor(next / (100 / stages.length)));
        setStageIndex(nextStage);
        if (next >= 100) {
          window.clearInterval(timer);
          window.setTimeout(() => setView("result"), 450);
          return 100;
        }
        return next;
      });
    }, 55);
    return () => window.clearInterval(timer);
  }, [view]);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    if (!next.type.startsWith("video/")) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(next);
    setVideoUrl(URL.createObjectURL(next));
  }

  function analyze() {
    if (!file) return;
    const candidates = buildPreviewMoments(sourceDuration || 780);
    setMoments(packTimeline(candidates, duration));
    setProgress(0);
    setStageIndex(0);
    setView("processing");
  }

  function toggleMoment(id: string) {
    setMoments((current) => current.map((moment) => moment.id === id ? { ...moment, selectedForFinalVideo: !moment.selectedForFinalVideo } : moment));
  }

  function regenerate() {
    setMoments((current) => packTimeline(current.map((item) => ({ ...item, selectedForFinalVideo: false })), duration));
  }

  function downloadPlan() {
    if (!file) return;
    const settings: EditSettings = { targetDuration: duration, aspectRatio: "9:16", commentary, playerHighlight: highlight, captions, originalAudio: audio, intensity };
    const blob = new Blob([JSON.stringify({ version: 1, source: { name: file.name, duration: sourceDuration }, settings, moments: selected }, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${file.name.replace(/\.[^.]+$/, "")}-touchline-edit-plan.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <main className="app-shell">
      <Sidebar view={view} onNew={() => setView("upload")} />
      <section className="workspace" id="new">
        {view === "upload" && (
          <UploadView
            file={file} videoUrl={videoUrl} inputRef={inputRef} chooseFile={chooseFile} setSourceDuration={setSourceDuration}
            duration={duration} setDuration={setDuration} commentary={commentary} setCommentary={setCommentary}
            highlight={highlight} setHighlight={setHighlight} captions={captions} setCaptions={setCaptions}
            audio={audio} setAudio={setAudio} intensity={intensity} setIntensity={setIntensity} analyze={analyze}
          />
        )}
        {view === "processing" && <ProcessingView fileName={file?.name ?? "Match footage"} progress={progress} stageIndex={stageIndex} />}
        {view === "result" && (
          <ResultView file={file} videoUrl={videoUrl} selected={selected} allMoments={moments} finalDuration={finalDuration}
            sourceDuration={sourceDuration} toggleMoment={toggleMoment} regenerate={regenerate} downloadPlan={downloadPlan} />
        )}
      </section>
    </main>
  );
}

function Sidebar({ view, onNew }: { view: View; onNew: () => void }) {
  return <aside className="sidebar">
    <button className="brand brand-button" onClick={onNew} aria-label="Touchline AI home"><span className="brand-mark"><span /></span><span>Touchline<span className="brand-accent">AI</span></span></button>
    <nav className="nav-list" aria-label="Main navigation">
      <button className={`nav-item ${view === "upload" ? "active" : ""}`} onClick={onNew}><span className="nav-icon">＋</span> New edit</button>
      <button className={`nav-item ${view !== "upload" ? "active" : ""}`}><span className="nav-icon">▱</span> Current project</button>
    </nav>
    <div className="sidebar-spacer" />
    <button className="nav-item sidebar-button"><span className="nav-icon">?</span> Processing guide</button>
    <div className="account-card"><div className="avatar">T</div><div><strong>Creator workspace</strong><span>Local preview</span></div><button aria-label="Account menu">•••</button></div>
  </aside>;
}

type UploadProps = {
  file: File | null; videoUrl: string | null; inputRef: React.RefObject<HTMLInputElement | null>;
  chooseFile: (file: File | undefined) => void; setSourceDuration: (value: number) => void;
  duration: number; setDuration: (value: number) => void; commentary: boolean; setCommentary: (value: boolean) => void;
  highlight: boolean; setHighlight: (value: boolean) => void; captions: boolean; setCaptions: (value: boolean) => void;
  audio: AudioMode; setAudio: (value: AudioMode) => void; intensity: Intensity; setIntensity: (value: Intensity) => void; analyze: () => void;
};

function UploadView(props: UploadProps) {
  const { file, videoUrl, inputRef, chooseFile, setSourceDuration, duration, setDuration, commentary, setCommentary, highlight, setHighlight, captions, setCaptions, audio, setAudio, intensity, setIntensity, analyze } = props;
  return <>
    <header className="topbar"><div><div className="eyebrow"><span className="pulse-dot" /> AI VIDEO STUDIO</div><h1>Create a football edit</h1></div><div className="step-indicator"><span>1</span> Upload & settings</div></header>
    <div className="content-grid">
      <section className="upload-column">
        <div className={`dropzone ${file ? "has-file" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]); }}>
          <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(event) => chooseFile(event.target.files?.[0])} />
          {file && videoUrl ? <video className="source-preview" src={videoUrl} muted preload="metadata" onLoadedMetadata={(event) => setSourceDuration(event.currentTarget.duration)} /> : <div className="upload-symbol">↥</div>}
          {file ? <><h2>{file.name}</h2><p>{formatBytes(file.size)} · Ready to analyze</p><button className="choose-button" onClick={() => inputRef.current?.click()}>Replace video</button></> : <><h2>Drop your match footage here</h2><p>We’ll scan the full video and find the moments worth watching.</p><button className="choose-button" onClick={() => inputRef.current?.click()}>Choose video</button><span className="file-hint">MP4, MOV or WebM · up to 2 GB</span></>}
        </div>
        <div className="trust-row"><span><i>✓</i> Full-video analysis</span><span><i>✓</i> Private processing</span><span><i>✓</i> One finished edit</span></div>
        <div className="format-preview"><div className="phone-frame"><div className="pitch-lines"><span>9:16</span></div></div><div><span className="mini-label">OUTPUT FORMAT</span><h3>Built for the vertical feed</h3><p>The crop follows the ball and key player to keep every move in frame—without bars or blurred padding.</p><div className="spec-row"><span>1080 × 1920</span><span>60–70 sec</span><span>MP4</span></div></div></div>
      </section>
      <aside className="settings-card" aria-label="Edit settings">
        <div className="settings-heading"><div><span className="mini-label">YOUR EDIT</span><h2>Settings</h2></div><button className="reset-button" onClick={() => { setDuration(65); setCommentary(true); setHighlight(true); setCaptions(true); setAudio("reduced"); setIntensity("dynamic"); }}>Reset</button></div>
        <Setting label="Final length" note="Target duration"><div className="segmented four">{[60, 65, 70, 80].map((value) => <button key={value} className={duration === value ? "selected" : ""} onClick={() => setDuration(value)}>{value}s{value === 65 && <small>DEFAULT</small>}</button>)}</div></Setting>
        <Setting label="Aspect ratio" note="Full-screen output"><button className="select-row"><span><b className="ratio-icon" /> 9:16 Vertical</span><span>⌄</span></button></Setting>
        <div className="toggle-group"><Toggle label="AI commentary" detail="Original analysis narration" checked={commentary} onChange={setCommentary} /><Toggle label="Player highlight" detail="Circle or spotlight key players" checked={highlight} onChange={setHighlight} /><Toggle label="Captions" detail="Burned-in dynamic subtitles" checked={captions} onChange={setCaptions} /></div>
        <Setting label="Original audio" note="Match sound level"><div className="segmented three">{(["normal", "reduced", "muted"] as AudioMode[]).map((value) => <button key={value} className={audio === value ? "selected" : ""} onClick={() => setAudio(value)}>{titleCase(value)}</button>)}</div></Setting>
        <Setting label="Editing intensity" note="Pacing and effects"><div className="segmented three">{(["natural", "dynamic", "high_energy"] as Intensity[]).map((value) => <button key={value} className={intensity === value ? "selected" : ""} onClick={() => setIntensity(value)}>{value === "high_energy" ? "High energy" : titleCase(value)}</button>)}</div></Setting>
        <button className="primary-button" disabled={!file} onClick={analyze}>Analyze football video <span>→</span></button>
        <p className="consent">Only upload footage you own or have permission to use.</p>
      </aside>
    </div>
  </>;
}

function ProcessingView({ fileName, progress, stageIndex }: { fileName: string; progress: number; stageIndex: number }) {
  return <div className="processing-page">
    <header className="topbar"><div><div className="eyebrow"><span className="pulse-dot" /> PROCESSING PROJECT</div><h1>Building your edit</h1></div><div className="step-indicator"><span>2</span> AI processing</div></header>
    <div className="processing-card">
      <div className="processing-visual"><div className="scan-field"><div className="scan-line" /><span className="tracked-player one" /><span className="tracked-player two" /><span className="tracked-ball" /></div><div className="percent">{progress}<small>%</small></div></div>
      <div className="processing-copy"><span className="mini-label">{fileName}</span><h2>{stages[stageIndex].label}</h2><p>{stages[stageIndex].detail}. You can leave this screen; long jobs continue in the background.</p><div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
        <ol className="stage-list">{stages.map((stage, index) => <li key={stage.key} className={index < stageIndex ? "done" : index === stageIndex ? "current" : ""}><i>{index < stageIndex ? "✓" : index + 1}</i><span><strong>{stage.label}</strong><small>{stage.detail}</small></span></li>)}</ol>
      </div>
    </div>
  </div>;
}

type ResultProps = { file: File | null; videoUrl: string | null; selected: FootballMoment[]; allMoments: FootballMoment[]; finalDuration: number; sourceDuration: number; toggleMoment: (id: string) => void; regenerate: () => void; downloadPlan: () => void };

function ResultView({ file, videoUrl, selected, allMoments, finalDuration, sourceDuration, toggleMoment, regenerate, downloadPlan }: ResultProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  function seek(moment: FootballMoment) { if (videoRef.current) { videoRef.current.currentTime = moment.startTime; void videoRef.current.play(); } }
  return <div className="result-page">
    <header className="topbar result-topbar"><div><div className="eyebrow"><span className="pulse-dot" /> EDIT READY</div><h1>Your football story</h1></div><div className="result-actions"><button className="secondary-button" onClick={regenerate}>↻ Regenerate timeline</button><button className="primary-compact" onClick={downloadPlan}>Download edit plan ↓</button></div></header>
    <div className="result-grid">
      <section className="preview-panel">
        <div className="preview-stage"><div className="vertical-video">{videoUrl ? <video ref={videoRef} src={videoUrl} controls playsInline /> : <div className="video-fallback">Preview unavailable</div>}<div className="analysis-label">WATCH THE SPACE HERE</div><div className="player-ring" /></div></div>
        <div className="preview-note"><span className="status-pill"><i /> Timeline complete</span><span>This browser preview uses the source file. The render worker applies the final crop, overlays, narration and captions.</span></div>
      </section>
      <aside className="timeline-panel">
        <div className="timeline-head"><div><span className="mini-label">SELECTED MOMENTS</span><h2>{selected.length} moments · {formatTime(finalDuration)}</h2></div><span className="duration-target">Target 65s</span></div>
        <div className="timeline-bar">{selected.map((moment) => <button key={moment.id} style={{ flex: moment.endTime - moment.startTime }} className={`bar-${moment.eventType}`} onClick={() => seek(moment)} title={moment.description} />)}</div>
        <div className="moment-list">{allMoments.map((moment, index) => <article key={moment.id} className={`moment-card ${moment.selectedForFinalVideo ? "" : "removed"}`}>
          <button className="moment-thumb" onClick={() => seek(moment)}><span>{index + 1}</span><i>▶</i></button>
          <button className="moment-main" onClick={() => seek(moment)}><span><b>{formatTime(moment.startTime)}–{formatTime(moment.endTime)}</b><em>{moment.eventType.replaceAll("_", " ")}</em></span><strong>{moment.description}</strong><small>{moment.commentary ?? "No commentary generated"}</small></button>
          <div className="score"><b>{moment.importanceScore}</b><small>SCORE</small></div>
          <button className="remove-moment" onClick={() => toggleMoment(moment.id)} aria-label={moment.selectedForFinalVideo ? "Remove moment" : "Restore moment"}>{moment.selectedForFinalVideo ? "×" : "+"}</button>
        </article>)}</div>
        <div className="summary-strip"><span><small>SOURCE</small><b>{formatTime(sourceDuration)}</b></span><span><small>FINAL</small><b>{formatTime(finalDuration)}</b></span><span><small>FORMAT</small><b>9:16 MP4</b></span></div>
      </aside>
    </div>
    <div className="render-banner"><div><span className="mini-label">PRODUCTION HANDOFF</span><strong>{file?.name}</strong><p>The edit plan is ready for the external FFmpeg/CV worker. Configure a processing provider to create the final MP4.</p></div><button onClick={downloadPlan}>Export JSON plan</button></div>
  </div>;
}

function Setting({ label, note, children }: { label: string; note: string; children: React.ReactNode }) { return <div className="setting"><div className="setting-label"><strong>{label}</strong><span>{note}</span></div>{children}</div>; }
function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="toggle-row"><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>; }
function formatBytes(bytes: number) { if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatTime(seconds: number) { const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0; return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`; }
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
