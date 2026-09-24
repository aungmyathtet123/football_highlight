"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditSettings, FootballMoment, JobStage } from "@/lib/video/types";

type View = "upload" | "processing" | "result";
type AudioMode = EditSettings["originalAudio"];
type Intensity = EditSettings["intensity"];
type EditStyle = NonNullable<EditSettings["editStyle"]>;

const stages: { key: JobStage; label: string; detail: string }[] = [
  { key: "uploaded", label: "Uploading", detail: "Securing your source footage" },
  { key: "analyzing", label: "Analyzing football", detail: "Scanning the entire match" },
  { key: "detecting_moments", label: "Finding key moments", detail: "Goals, chances, saves and skills" },
  { key: "tracking", label: "Verifying action & camera", detail: "Tracking selected incidents and reusing saved observations" },
  { key: "writing_content", label: "Writing the analysis", detail: "Creating the strongest complete story, at least 60 seconds" },
  { key: "aligning_content", label: "Aligning video evidence", detail: "Matching every content beat to the best footage" },
  { key: "generating_commentary", label: "Recording final narration", detail: "Fitting the voice to the locked visual edit" },
  { key: "editing", label: "Editing", detail: "Pacing, captions, masking and emphasis" },
  { key: "rendering", label: "Rendering", detail: "Composing one 9:16 MP4" },
  { key: "validating", label: "Quality checking", detail: "Reviewing framing, tracking, audio and transitions" },
];

// Production points this at the public HTTPS origin. Caddy forwards the API
// paths to the private processor, so browsers never need access to port 8787.
const processorUrl = (process.env.NEXT_PUBLIC_PROCESSOR_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

type LocalJob = {
  id: string; stage: JobStage; progress: number; moments: FootballMoment[];
  progressDetail?: string;
  outputUrl?: string; analysisProvider?: "gemini" | "local_fallback"; warnings?: string[];
  media?: { duration: number }; editPlan?: Record<string, unknown>;
  error?: { code?: string; message: string; retryable?: boolean };
};

type YouTubeChannel = {
  channelId: string; title: string; handle?: string; thumbnailUrl?: string;
  subscriberCount: number; connectedAt: string;
};

type YouTubeUpload = {
  jobId: string; channelId: string; videoId: string; title: string;
  privacyStatus: "private"; status: "completed"; uploadedAt: string; url: string;
};

export function VideoStudio() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [editStyle, setEditStyle] = useState<EditStyle>("complete_highlights");
  const [commentary, setCommentary] = useState(true);
  const [highlight, setHighlight] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [logoMasking, setLogoMasking] = useState(true);
  const [audio, setAudio] = useState<AudioMode>("muted");
  const [intensity, setIntensity] = useState<Intensity>("dynamic");
  const [recapBrief, setRecapBrief] = useState("");
  const [stageIndex, setStageIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [progressDetail, setProgressDetail] = useState("");
  const [moments, setMoments] = useState<FootballMoment[]>([]);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editPlan, setEditPlan] = useState<Record<string, unknown> | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [failureProgress, setFailureProgress] = useState(0);
  const [retrying, setRetrying] = useState(false);

  const selected = useMemo(() => moments.filter((moment) => moment.selectedForFinalVideo), [moments]);
  const finalDuration = selected.reduce((sum, moment, index) => {
    const clipDuration = (moment.endTime - moment.startTime) / (moment.playbackRate || 1);
    return sum + clipDuration - (index === 0 ? 0 : moment.transitionDuration || 0);
  }, 0);

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    if (!next.type.startsWith("video/")) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(next);
    setVideoUrl(URL.createObjectURL(next));
  }

  function showCompletedJob(job: LocalJob) {
    setMoments(job.moments);
    setWarnings(job.warnings || []);
    setEditPlan(job.editPlan || null);
    setOutputUrl(job.outputUrl || null);
    if (job.media?.duration) setSourceDuration(job.media.duration);
    setProcessingError(null);
    setView("result");
  }

  async function monitorJob(id: string) {
    for (;;) {
      const statusResponse = await fetch(`${processorUrl}/jobs/${id}`, { cache: "no-store" });
      if (!statusResponse.ok) throw new Error("Could not read the saved processing job.");
      const job = await statusResponse.json() as LocalJob;
      setProgress(job.progress);
      setProgressDetail(job.progressDetail || "");
      setStageIndex(stageIndexFor(job.stage));
      if (job.stage === "failed") {
        setFailureProgress(job.progress);
        throw new Error(job.error?.message || "Video processing failed.");
      }
      if (job.stage === "completed") {
        showCompletedJob(job);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }

  async function analyze() {
    if (!file) return;
    setProgress(0);
    setProgressDetail("");
    setStageIndex(0);
    setProcessingError(null);
    setWarnings([]);
    setEditPlan(null);
    setOutputUrl(null);
    setCurrentJobId(null);
    setFailureProgress(0);
    setView("processing");
    const viral = editStyle === "viral_reel";
    const settings: EditSettings = { editStyle, durationMode: "auto", recapBrief, targetDuration: viral ? 36 : editStyle === "complete_highlights" ? 60 : 30, durationMin: editStyle === "complete_highlights" ? 60 : 30, aspectRatio: viral ? "4:5" : editStyle === "complete_highlights" ? "16:9" : "9:16", commentary: editStyle === "complete_highlights" ? true : commentary, playerHighlight: highlight, captions, logoMasking, originalAudio: editStyle === "complete_highlights" ? "muted" : audio, intensity };
    try {
      const response = await fetch(`${processorUrl}/jobs`, {
        method: "POST", body: file, headers: {
          "Content-Type": file.type || "video/mp4",
          "X-File-Name": encodeURIComponent(file.name),
          "X-Edit-Settings": toBase64Url(JSON.stringify(settings)),
        },
      });
      const created = await response.json() as LocalJob & { error?: string };
      if (!response.ok) throw new Error(typeof created.error === "string" ? created.error : "The local processor rejected the upload.");
      setCurrentJobId(created.id);
      await monitorJob(created.id);
    } catch (error) {
      setProcessingError(error instanceof Error ? error.message : "The local processor could not be reached.");
    }
  }

  async function resumeProcessing() {
    if (!currentJobId) {
      await analyze();
      return;
    }
    setRetrying(true);
    setProcessingError(null);
    setProgressDetail("Checking the saved job before retrying...");
    try {
      const statusResponse = await fetch(`${processorUrl}/jobs/${currentJobId}`, { cache: "no-store" });
      if (!statusResponse.ok) throw new Error("The saved job could not be found. Start a new upload.");
      const job = await statusResponse.json() as LocalJob;
      if (job.stage === "completed") {
        showCompletedJob(job);
        return;
      }
      if (job.stage === "failed") {
        const retryKind = Number(job.progress || failureProgress) >= 84 ? "retry-render" : "retry-analysis";
        const retryResponse = await fetch(`${processorUrl}/jobs/${currentJobId}/${retryKind}`, { method: "POST" });
        const retryJob = await retryResponse.json() as LocalJob & { error?: string };
        if (!retryResponse.ok && retryResponse.status !== 409) {
          throw new Error(typeof retryJob.error === "string" ? retryJob.error : "The saved job could not be resumed.");
        }
      }
      await monitorJob(currentJobId);
    } catch (error) {
      setProcessingError(error instanceof Error ? error.message : "The saved job could not be resumed.");
    } finally {
      setRetrying(false);
    }
  }

  function downloadPlan() {
    if (!file) return;
    const viral = editStyle === "viral_reel";
    const settings: EditSettings = { editStyle, durationMode: "auto", targetDuration: Number(editPlan?.plannedDuration || (viral ? 36 : 30)), durationMin: 30, aspectRatio: viral ? "4:5" : editStyle === "complete_highlights" ? "16:9" : "9:16", commentary, playerHighlight: highlight, captions, logoMasking, originalAudio: editStyle === "complete_highlights" ? "muted" : audio, intensity };
    const blob = new Blob([JSON.stringify({ version: 2, source: { name: file.name, duration: sourceDuration }, settings, contentPlan: editPlan, moments: selected }, null, 2)], { type: "application/json" });
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
            editStyle={editStyle} setEditStyle={(value) => { setEditStyle(value); if (value === "complete_highlights" || value === "viral_reel") { setCommentary(true); setAudio(value === "complete_highlights" ? "muted" : "reduced"); } }}
            commentary={commentary} setCommentary={setCommentary}
            highlight={highlight} setHighlight={setHighlight} captions={captions} setCaptions={setCaptions} logoMasking={logoMasking} setLogoMasking={setLogoMasking}
            recapBrief={recapBrief} setRecapBrief={setRecapBrief} audio={audio} setAudio={setAudio} intensity={intensity} setIntensity={setIntensity} analyze={analyze}
          />
        )}
        {view === "processing" && <ProcessingView fileName={file?.name ?? "Match footage"} progress={progress} detail={progressDetail} stageIndex={stageIndex} error={processingError} canResume={Boolean(currentJobId)} retrying={retrying} onRetry={resumeProcessing} onBack={() => setView("upload")} />}
        {view === "result" && (
          <ResultView file={file} videoUrl={outputUrl || videoUrl} outputUrl={outputUrl} warnings={warnings} selected={selected} allMoments={moments} finalDuration={finalDuration}
            sourceDuration={sourceDuration} videoTitle={typeof editPlan?.title === "string" ? editPlan.title : "Your football story"} editStyle={editStyle} downloadPlan={downloadPlan} jobId={currentJobId} />
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
  editStyle: EditStyle; setEditStyle: (value: EditStyle) => void;
  commentary: boolean; setCommentary: (value: boolean) => void;
  highlight: boolean; setHighlight: (value: boolean) => void; captions: boolean; setCaptions: (value: boolean) => void;
  logoMasking: boolean; setLogoMasking: (value: boolean) => void;
  recapBrief: string; setRecapBrief: (value: string) => void;
  audio: AudioMode; setAudio: (value: AudioMode) => void; intensity: Intensity; setIntensity: (value: Intensity) => void; analyze: () => void;
};

function UploadView(props: UploadProps) {
  const { file, videoUrl, inputRef, chooseFile, setSourceDuration, editStyle, setEditStyle, commentary, setCommentary, highlight, setHighlight, captions, setCaptions, logoMasking, setLogoMasking, recapBrief, setRecapBrief, audio, setAudio, intensity, setIntensity, analyze } = props;
  const viral = editStyle === "viral_reel";
  const complete = editStyle === "complete_highlights";
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
        <div className={`format-preview ${viral ? "reel-format" : ""}`}><div className="phone-frame"><div className="pitch-lines"><span>{complete ? "16:9" : viral ? "4:5" : "9:16"}</span></div></div><div><span className="mini-label">OUTPUT FORMAT</span><h3>{complete ? "16:9 original football analysis" : viral ? "Compact 4:5 viral reel" : "Full-screen 9:16 tactical analysis"}</h3><p>{complete ? "Uses only necessary action evidence under continuous original narration, with live tactical networks, freezes, telestration and captions. This strengthens the analytical purpose but cannot guarantee fair use or prevent claims." : "The frame is filled edge to edge while the smart crop follows the ball, active player and nearby action."}</p><div className="spec-row"><span>{complete ? "1920 × 1080" : viral ? "1080 × 1350" : "1080 × 1920"}</span><span>{complete ? "Adaptive · evidence-led" : "30+ sec · AI selected"}</span><span>MP4</span></div></div></div>
      </section>
      <aside className="settings-card" aria-label="Edit settings">
        <div className="settings-heading"><div><span className="mini-label">YOUR EDIT</span><h2>Settings</h2></div><button className="reset-button" onClick={() => { setEditStyle("complete_highlights"); setCommentary(true); setHighlight(true); setCaptions(true); setLogoMasking(true); setAudio("muted"); setIntensity("dynamic"); setRecapBrief(""); }}>Reset</button></div>
        <Setting label="Edit style" note="Choose the storytelling system"><div className="segmented two">{(["complete_highlights", "tactical_analysis"] as EditStyle[]).map((value) => <button key={value} className={editStyle === value ? "selected" : ""} onClick={() => { setEditStyle(value); if (value === "complete_highlights" || value === "viral_reel") { setCommentary(true); setAudio(value === "complete_highlights" ? "muted" : "reduced"); } }}>{value === "complete_highlights" ? "Analysis recap" : "Tactical"}</button>)}</div></Setting>
        {complete && <Setting label="Recap request" note="Optional · natural language"><textarea className="recap-brief" value={recapBrief} maxLength={320} rows={3} onChange={(event) => setRecapBrief(event.target.value)} placeholder="Create a 2-minute recap covering every goal and explain why the result happened." /><small className="recap-hint">Describe any match, duration, score or angle. Teams, scores and players are verified externally before use.</small></Setting>}
        <Setting label="Adaptive highlight length" note={complete ? "Based on source duration" : "At least 30 seconds"}><p>{complete ? "Keeps every verified goal, removes downtime, and caps 5–7 minute sources at 2 minutes and long sources at 4–5 minutes." : "AI chooses the best complete moments and lets the story set the length."}</p></Setting>
        <Setting label="Aspect ratio" note="Stable full-frame output"><div className="select-row"><span><b className="ratio-icon" /> {complete ? "16:9 Native" : viral ? "4:5 Social" : "9:16 Vertical"}</span></div></Setting>
        <div className="toggle-group"><Toggle label="AI commentary" detail={complete ? "Required evidence-specific criticism and analysis" : viral ? "Short analysis mixed over quieter match sound" : "Replaces the source audio with analysis narration"} checked={complete || commentary} disabled={complete} onChange={(value) => { setCommentary(value); if (value) setAudio(viral ? "reduced" : "muted"); }} /><Toggle label="Player highlight" detail="Large thick red circle on the verified active player only" checked={highlight} onChange={setHighlight} /><Toggle label="Captions" detail="Sparse bold story captions" checked={captions} onChange={setCaptions} /><Toggle label="Logo / watermark masking" detail="Blur authorized persistent overlays" checked={logoMasking} onChange={setLogoMasking} /></div>
        <Setting label="Source audio" note={complete ? "Broadcast commentary and source music are always removed" : commentary ? (viral ? "Ducked beneath the analysis voice" : "Muted while AI commentary is enabled") : "Match sound level"}><div className="segmented three">{(["normal", "reduced", "muted"] as AudioMode[]).map((value) => <button key={value} disabled={complete || (!viral && commentary)} className={(complete ? value === "muted" : audio === value) ? "selected" : ""} onClick={() => setAudio(value)}>{titleCase(value)}</button>)}</div></Setting>
        <Setting label="Editing intensity" note="Pacing and effects"><div className="segmented three">{(["natural", "dynamic", "high_energy"] as Intensity[]).map((value) => <button key={value} className={intensity === value ? "selected" : ""} onClick={() => setIntensity(value)}>{value === "high_energy" ? "High energy" : titleCase(value)}</button>)}</div></Setting>
        <button className="primary-button" disabled={!file} onClick={analyze}>Analyze football video <span>→</span></button>
        <p className="consent">Only upload footage you own, have licensed, or are legally permitted to use. Editing effects cannot guarantee fair use or prevent platform claims.</p>
      </aside>
    </div>
  </>;
}

function ProcessingView({ fileName, progress, detail, stageIndex, error, canResume, retrying, onRetry, onBack }: { fileName: string; progress: number; detail: string; stageIndex: number; error: string | null; canResume: boolean; retrying: boolean; onRetry: () => void; onBack: () => void }) {
  return <div className="processing-page">
    <header className="topbar"><div><div className="eyebrow"><span className="pulse-dot" /> PROCESSING PROJECT</div><h1>Building your edit</h1></div><div className="step-indicator"><span>2</span> AI processing</div></header>
    <div className="processing-card">
      <div className="processing-visual"><div className="scan-field"><div className="scan-line" /><span className="tracked-player one" /><span className="tracked-player two" /><span className="tracked-ball" /></div><div className="percent">{progress}<small>%</small></div></div>
      <div className="processing-copy"><span className="mini-label">{fileName}</span><h2>{error ? "Processing paused" : stages[stageIndex].label}</h2><p role="status" aria-live="polite">{error || detail || `${stages[stageIndex].detail}. Keep the local processor running.`}</p>{error && <div className="retry-actions"><button className="primary-compact" disabled={retrying} onClick={onRetry}>{retrying ? "Resuming..." : canResume ? "Resume saved job" : "Retry upload"}</button><button className="secondary-button" disabled={retrying} onClick={onBack}>Review settings</button></div>}<div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
        <ol className="stage-list">{stages.map((stage, index) => <li key={stage.key} className={index < stageIndex ? "done" : index === stageIndex ? "current" : ""}><i>{index < stageIndex ? "✓" : index + 1}</i><span><strong>{stage.label}</strong><small>{stage.detail}</small></span></li>)}</ol>
      </div>
    </div>
  </div>;
}

type ResultProps = { file: File | null; videoUrl: string | null; outputUrl: string | null; warnings: string[]; selected: FootballMoment[]; allMoments: FootballMoment[]; finalDuration: number; sourceDuration: number; videoTitle: string; editStyle: EditStyle; downloadPlan: () => void; jobId: string | null };

function ResultView({ file, videoUrl, outputUrl, warnings, selected, allMoments, finalDuration, sourceDuration, videoTitle, editStyle, downloadPlan, jobId }: ResultProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState<"title" | "hashtags" | "all" | null>(null);
  const hashtags = publishingHashtags(selected, editStyle);
  function seek(moment: FootballMoment) { if (videoRef.current) { videoRef.current.currentTime = moment.startTime; void videoRef.current.play(); } }
  async function copyPublishingText(kind: "title" | "hashtags" | "all") {
    const text = kind === "title" ? videoTitle : kind === "hashtags" ? hashtags : `${videoTitle}\n\n${hashtags}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = text;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand("copy");
      fallback.remove();
    }
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
  }
  return <div className="result-page">
    <header className="topbar result-topbar"><div><div className="eyebrow"><span className="pulse-dot" /> EDIT READY</div><h1>{videoTitle}</h1></div><div className="result-actions"><button className="secondary-button" onClick={downloadPlan}>Download edit plan</button>{outputUrl && <a className="primary-compact" href={outputUrl} download={`${file?.name.replace(/\.[^.]+$/, "") || "touchline"}-vertical.mp4`}>Download MP4 ↓</a>}</div></header>
    <div className="result-grid">
      <section className="preview-panel">
        <div className="preview-stage"><div className={`vertical-video ${editStyle === "complete_highlights" ? "landscape-video" : ""}`}>{videoUrl ? <video ref={videoRef} src={videoUrl} controls playsInline><track kind="captions" label="Captions are included when generated" /></video> : <div className="video-fallback">Preview unavailable</div>}</div></div>
        <div className="preview-note"><span className="status-pill"><i /> Render complete</span><span>{outputUrl ? `This is the locally rendered ${editStyle === "complete_highlights" ? "16:9 analysis" : "9:16"} MP4.` : "Rendered preview unavailable."}</span></div>
        {warnings.map((warning) => <div className="preview-note" key={warning}><span>{warning}</span></div>)}
      </section>
      <aside className="timeline-panel">
        <div className="timeline-head"><div><span className="mini-label">SELECTED MOMENTS</span><h2>{selected.length} moments · {formatTime(finalDuration)}</h2></div><span className="duration-target">Adaptive · every verified goal</span></div>
        <div className="timeline-bar">{selected.map((moment) => <button key={moment.id} style={{ flex: moment.endTime - moment.startTime }} className={`bar-${moment.eventType}`} onClick={() => seek(moment)} title={moment.description} />)}</div>
        <div className="moment-list">{allMoments.map((moment, index) => <article key={moment.id} className={`moment-card ${moment.selectedForFinalVideo ? "" : "removed"}`}>
          <button className="moment-thumb" onClick={() => seek(moment)}><span>{index + 1}</span><i>▶</i></button>
          <button className="moment-main" onClick={() => seek(moment)}><span><b>{formatTime(moment.startTime)}–{formatTime(moment.endTime)}</b><em>{moment.eventType.replaceAll("_", " ")}</em></span><strong>{moment.description}</strong><small>{moment.commentary ?? "No commentary generated"}</small></button>
          <div className="score"><b>{moment.importanceScore}</b><small>SCORE</small></div>
        </article>)}</div>
        <div className="summary-strip"><span><small>SOURCE</small><b>{formatTime(sourceDuration)}</b></span><span><small>FINAL</small><b>{formatTime(finalDuration)}</b></span><span><small>FORMAT</small><b>{editStyle === "complete_highlights" ? "16:9" : "9:16"} MP4</b></span></div>
      </aside>
    </div>
    <section className="publishing-card" aria-labelledby="publishing-title">
      <div className="publishing-head"><div><span className="mini-label">READY TO PUBLISH</span><h2 id="publishing-title">Title and hashtags</h2><p>Generated from the verified recap so you can copy and paste them when uploading.</p></div><button className="primary-compact" onClick={() => void copyPublishingText("all")}>{copied === "all" ? "Copied!" : "Copy title + hashtags"}</button></div>
      <div className="publishing-fields">
        <div className="publishing-field"><div><label htmlFor="publishing-video-title">Video title</label><button onClick={() => void copyPublishingText("title")}>{copied === "title" ? "Copied!" : "Copy title"}</button></div><textarea id="publishing-video-title" readOnly rows={2} value={videoTitle} /></div>
        <div className="publishing-field"><div><label htmlFor="publishing-hashtags">Hashtags</label><button onClick={() => void copyPublishingText("hashtags")}>{copied === "hashtags" ? "Copied!" : "Copy hashtags"}</button></div><textarea id="publishing-hashtags" readOnly rows={3} value={hashtags} /></div>
      </div>
      {outputUrl && jobId && <YouTubePublishingPanel jobId={jobId} videoTitle={videoTitle} hashtags={hashtags} />}
    </section>
    <div className="render-banner"><div><span className="mini-label">PRIVATE LOCAL OUTPUT</span><strong>{file?.name}</strong><p>The source, job data and finished video are stored only in this project&apos;s local-data folder.</p></div>{outputUrl ? <a href={outputUrl} download>Download MP4</a> : <button onClick={downloadPlan}>Export JSON plan</button>}</div>
  </div>;
}

function YouTubePublishingPanel({ jobId, videoTitle, hashtags }: { jobId: string; videoTitle: string; hashtags: string }) {
  const [configured, setConfigured] = useState(true);
  const [channels, setChannels] = useState<YouTubeChannel[]>([]);
  const [uploads, setUploads] = useState<YouTubeUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [uploadingChannelId, setUploadingChannelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshChannels() {
    try {
      const response = await fetch(`${processorUrl}/youtube/channels`, { cache: "no-store" });
      const data = await response.json() as { configured?: boolean; channels?: YouTubeChannel[]; uploads?: YouTubeUpload[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not read connected YouTube channels.");
      setConfigured(data.configured !== false);
      setChannels(data.channels || []);
      setUploads((data.uploads || []).filter((upload) => upload.jobId === jobId));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not reach the YouTube publisher.");
    } finally {
      setLoading(false);
      setConnecting(false);
    }
  }

  useEffect(() => {
    void refreshChannels();
    function onMessage(event: MessageEvent) {
      if (event.origin !== new URL(processorUrl).origin || event.data?.type !== "touchline-youtube-connected") return;
      if (event.data.error) setError(String(event.data.error));
      void refreshChannels();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [jobId]);

  function connectChannel() {
    setConnecting(true);
    setError(null);
    const returnTo = window.location.origin;
    const popup = window.open(`${processorUrl}/youtube/oauth/start?returnTo=${encodeURIComponent(returnTo)}`, "touchline-youtube-oauth", "popup=yes,width=620,height=760");
    if (!popup) {
      setConnecting(false);
      setError("Your browser blocked the Google connection window. Allow popups for this page and try again.");
    }
  }

  async function uploadToChannel(channel: YouTubeChannel) {
    setUploadingChannelId(channel.channelId);
    setError(null);
    try {
      const response = await fetch(`${processorUrl}/youtube/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, channelId: channel.channelId, title: videoTitle, description: hashtags }),
      });
      const data = await response.json() as YouTubeUpload & { error?: string };
      if (!response.ok) throw new Error(data.error || "YouTube upload failed.");
      setUploads((current) => [...current.filter((upload) => upload.channelId !== data.channelId), data]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "YouTube upload failed.");
    } finally {
      setUploadingChannelId(null);
    }
  }

  return <div className="youtube-publisher" aria-labelledby="youtube-publisher-title">
    <div className="youtube-publisher-head">
      <div><span className="mini-label">YOUTUBE</span><h3 id="youtube-publisher-title">Choose exactly one channel</h3><p>Uploads are Private for review. Channel IDs prevent duplicate names from causing a wrong upload.</p></div>
      <button className="secondary-button" disabled={connecting || !configured} onClick={connectChannel}>{connecting ? "Opening Google..." : channels.length ? "Connect another channel" : "Connect YouTube channel"}</button>
    </div>
    {!configured && <p className="publish-error">YouTube OAuth is not configured on this processor.</p>}
    {error && <p className="publish-error" role="alert">{error}</p>}
    {loading ? <p className="youtube-empty">Checking connected channels...</p> : channels.length === 0 ? <p className="youtube-empty">Connect each GoalVision account once. Both channels will then appear here as separate upload buttons.</p> : <div className="youtube-channel-list">
      {channels.map((channel) => {
        const uploaded = uploads.find((item) => item.channelId === channel.channelId);
        const uploading = uploadingChannelId === channel.channelId;
        return <article className="youtube-channel" key={channel.channelId}>
          <div className="youtube-avatar">{channel.thumbnailUrl ? <img src={channel.thumbnailUrl} alt="" /> : channel.title.slice(0, 1)}</div>
          <div className="youtube-channel-copy"><strong>{channel.title}</strong><span>{channel.handle || channel.channelId}</span><small>{formatSubscribers(channel.subscriberCount)} subscribers · ID …{channel.channelId.slice(-6)}</small></div>
          {uploaded ? <a className="youtube-uploaded" href={uploaded.url} target="_blank" rel="noreferrer">Uploaded · Review on YouTube</a> : <button className="youtube-upload-button" disabled={Boolean(uploadingChannelId)} onClick={() => void uploadToChannel(channel)}>{uploading ? "Uploading..." : "Upload privately"}</button>}
        </article>;
      })}
    </div>}
  </div>;
}

function Setting({ label, note, children }: { label: string; note: string; children: React.ReactNode }) { return <div className="setting"><div className="setting-label"><strong>{label}</strong><span>{note}</span></div>{children}</div>; }
function Toggle({ label, detail, checked, disabled = false, onChange }: { label: string; detail: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) { return <label className={`toggle-row ${disabled ? "disabled" : ""}`} aria-label={label}><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><i /></label>; }
function formatBytes(bytes: number) { if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatTime(seconds: number) { const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0; return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`; }
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatSubscribers(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0); }
function publishingHashtags(moments: FootballMoment[], editStyle: EditStyle) {
  const events = new Set(moments.map((moment) => moment.eventType));
  const tags = ["#GoalVision", "#Football", "#FootballHighlights", "#MatchRecap", "#FootballAnalysis"];
  if (events.has("goal") || events.has("disallowed_goal")) tags.push("#Goals");
  if (events.has("save")) tags.push("#Goalkeeper");
  if (events.has("assist")) tags.push("#Assists");
  if (events.has("shot_on_target") || events.has("shot_off_target") || events.has("big_chance")) tags.push("#MatchHighlights");
  if (editStyle === "tactical_analysis") tags.push("#TacticalAnalysis");
  return [...new Set(tags)].join(" ");
}
function stageIndexFor(stage: JobStage) { const index = stages.findIndex((item) => item.key === stage); if (index >= 0) return index; if (stage === "ranking") return stages.findIndex((item) => item.key === "aligning_content"); return stages.length - 1; }
function toBase64Url(value: string) { const bytes = new TextEncoder().encode(value); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); return window.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
