"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EditSettings, FootballMoment, JobStage } from "@/lib/video/types";
import {buildWorkflowProgress,type WorkflowProgress} from '@/local-processor/workflow-progress.mjs';
import {sourceDurationProblem} from '@/local-processor/source-duration-policy.mjs';

type View = "upload" | "jobs" | "processing" | "result";
type LibraryTab = "all" | "originals" | "recaps" | "queue";
type CloudJobStage = JobStage | "importing" | "uploading" | "queued" | "downloading" | "restoring";
type AudioMode = EditSettings["originalAudio"];
type Intensity = EditSettings["intensity"];
type EditStyle = NonNullable<EditSettings["editStyle"]>;
type OutputRatio = "16:9" | "9:16" | "4:3" | "1:1";

// Production points this at the public HTTPS origin. Caddy forwards the API
// paths to the private processor, so browsers never need access to port 8787.
// A relative API base keeps cloud previews, downloads, and OAuth on the same origin.
const processorUrl = (process.env.NEXT_PUBLIC_PROCESSOR_URL || "").replace(/\/+$/, "");

type LocalJob = {
  id: string; stage: CloudJobStage; progress: number; moments: FootballMoment[];
  sourceName?: string; sourceSize?: number; createdAt?: string; updatedAt?: string; completedAt?: string;
  sourceKind?: "youtube" | "remote" | "upload"; sourcePageUrl?: string; sourceVideoId?: string; sourceThumbnailUrl?: string; sourceDuration?: number; readyToAnalyze?: boolean; importedAt?: string;
  uploadedBytes?: number;
  resumeAvailable?: boolean; checkpointProgress?: number; checkpointSavedAt?: string;
  publishedAt?: string; youtubeUrl?: string;
  progressDetail?: string;
  workflow?: WorkflowProgress;
  settings?: EditSettings;
  outputUrl?: string; analysisProvider?: "gemini" | "local_fallback"; warnings?: string[];
  media?: { duration: number }; editPlan?: Record<string, unknown>;
  error?: { code?: string; message: string; retryable?: boolean };
  retention?: { sourceDeleteAt: string; outputDeleteAt: string; sourceDeleted: boolean; outputDeleted: boolean; published: boolean };
};

type JobListResponse = { jobs: LocalJob[]; storageBytes: number; jobCount: number };

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
  const monitorController=useRef<AbortController | null>(null);
  const [view, setView] = useState<View>("upload");
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("all");
  const [file, setFile] = useState<File | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [editStyle, setEditStyle] = useState<EditStyle>("complete_highlights");
  const [aspectRatio, setAspectRatio] = useState<OutputRatio>("9:16");
  const [commentary, setCommentary] = useState(true);
  const [highlight, setHighlight] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [logoMasking, setLogoMasking] = useState(true);
  const [audio, setAudio] = useState<AudioMode>("muted");
  const [intensity, setIntensity] = useState<Intensity>("dynamic");
  const [recapBrief, setRecapBrief] = useState("");
  const [processingJob,setProcessingJob] = useState<LocalJob | null>(null);
  const [currentStage, setCurrentStage] = useState<CloudJobStage>("uploaded");
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
  const [resumeUploadJob, setResumeUploadJob] = useState<LocalJob | null>(null);
  const [sourceJob, setSourceJob] = useState<LocalJob | null>(null);
  const [sourceMode, setSourceMode] = useState<"file" | "youtube">("file");
  const [importUrl, setImportUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [storageBytes, setStorageBytes] = useState(0);

  const selected = useMemo(() => moments.filter((moment) => moment.selectedForFinalVideo), [moments]);
  const finalDuration = selected.reduce((sum, moment, index) => {
    const clipDuration = (moment.endTime - moment.startTime) / (moment.playbackRate || 1);
    return sum + clipDuration - (index === 0 ? 0 : moment.transitionDuration || 0);
  }, 0);

  useEffect(() => () => { if (videoUrl?.startsWith("blob:")) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  useEffect(()=>()=>monitorController.current?.abort(),[]);
  useEffect(()=>{if(view!=="processing")monitorController.current?.abort();},[view]);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `${view === "upload" ? "New football edit" : view === "jobs" ? "Video library" : view === "processing" ? "Processing" : "Review & publish"} · Touchline AI`;
  }, [view, libraryTab]);
  useEffect(() => {
    void loadJobs();
    if (view !== "jobs") return;
    const timer = window.setInterval(() => void loadJobs(true), 5000);
    return () => window.clearInterval(timer);
  }, [view]);

  async function loadJobs(silent = false) {
    if (!silent) setJobsLoading(true);
    try {
      const response = await fetch(`${processorUrl}/jobs`, { cache: "no-store" });
      const data = await response.json() as JobListResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load saved projects.");
      setJobs(data.jobs || []);
      setStorageBytes(Number(data.storageBytes || 0));
      setJobsError(null);
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : "Could not load saved projects.");
    } finally {
      if (!silent) setJobsLoading(false);
    }
  }

  function chooseFile(next: File | undefined) {
    if (!next) return;
    if (!next.type.startsWith("video/")) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(next);
    setSourceJob(null);
    setVideoUrl(URL.createObjectURL(next));
  }

  function selectReadySource(job: LocalJob) {
    monitorController.current?.abort();
    setCurrentJobId(job.id);
    setSourceJob(job);
    setResumeUploadJob(null);
    setFile(null);
    if (videoUrl?.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    setVideoUrl(`${processorUrl}/sources/${job.id}`);
    setSourceDuration(Number(job.sourceDuration || job.media?.duration || 0));
    setProcessingError(null);
    setImportError(null);
    setView("upload");
  }

  function prepareUploadResume(job: LocalJob) {
    monitorController.current?.abort();
    setCurrentJobId(job.id);
    setResumeUploadJob(job);
    setSourceJob(null);
    setFile(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setProcessingError(null);
    setCurrentStage("uploading");
    setView("upload");
  }

  function showCompletedJob(job: LocalJob) {
    setMoments(job.moments);
    setWarnings(job.warnings || []);
    setEditPlan(job.editPlan || null);
    if (job.settings?.editStyle) setEditStyle(job.settings.editStyle);
    if (job.settings?.aspectRatio && ["9:16", "16:9", "4:3", "1:1"].includes(job.settings.aspectRatio)) setAspectRatio(job.settings.aspectRatio as OutputRatio);
    setOutputUrl(job.outputUrl ? `${processorUrl}/outputs/${job.id}/final.mp4` : null);
    if (job.media?.duration) setSourceDuration(job.media.duration);
    setProcessingError(null);
    setView("result");
  }

  function openSavedJob(job: LocalJob) {
    monitorController.current?.abort();
    if (job.stage === "uploading" || (job.stage === "uploaded" && Number(job.progress || 0) < 5)) return prepareUploadResume(job);
    if (job.stage === "uploaded" && job.readyToAnalyze) return selectReadySource(job);
    setCurrentJobId(job.id);
    setSourceJob(null);
    setResumeUploadJob(null);
    setProgress(jobDisplayProgress(job));
    setProgressDetail(job.progressDetail || "");
    setProcessingJob(job);
    setCurrentStage(job.stage);
    setFailureProgress(job.progress || 0);
    setFile(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    if (job.stage === "completed") return showCompletedJob(job);
    setProcessingError(job.stage === "failed" ? job.error?.message || "Processing paused." : null);
    setView("processing");
    if (job.stage !== "failed") void monitorJob(job.id).catch((error) => setProcessingError(error instanceof Error ? error.message : "Could not reconnect to this job."));
  }

  async function retrySavedJob(job: LocalJob) {
    setProcessingJob(job);
    setCurrentJobId(job.id);
    setProgress(job.progress || 0);
    setFailureProgress(job.progress || 0);
    setProcessingError(null);
    setCurrentStage("queued");
    setView("processing");
    try {
      const retryKind = ["youtube", "remote"].includes(job.sourceKind || "") && !job.importedAt ? "retry-import" : Number(job.progress || 0) >= 84 ? "retry-render" : "retry-analysis";
      const response = await fetch(`${processorUrl}/jobs/${job.id}/${retryKind}`, { method: "POST" });
      const data = await response.json() as LocalJob & { error?: string };
      if (!response.ok && response.status !== 409) throw new Error(typeof data.error === "string" ? data.error : "The saved job could not be resumed.");
      await monitorJob(job.id);
    } catch (error) {
      setProcessingError(error instanceof Error ? error.message : "The saved job could not be resumed.");
    }
  }

  async function deleteSavedJob(job: LocalJob) {
    if (!window.confirm(`Delete ${job.sourceName || "this project"} and its stored video files? This cannot be undone.`)) return;
    const response = await fetch(`${processorUrl}/jobs/${job.id}`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      setJobsError(data.error || "The project could not be deleted.");
      return;
    }
    await loadJobs();
  }

  async function markPublishedJob(job: LocalJob) {
    if (!window.confirm("Confirm that this video has been uploaded to YouTube. Its source will be removed after 24 hours and the finished MP4 after 7 days.")) return;
    const response = await fetch(`${processorUrl}/jobs/${job.id}/published`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: job.youtubeUrl || "" }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      setJobsError(data.error || "Publication could not be saved.");
      return;
    }
    await loadJobs();
  }

  async function monitorJob(id: string) {
    monitorController.current?.abort();
    const controller=new AbortController();
    monitorController.current=controller;
    while (!controller.signal.aborted) {
      let statusResponse:Response;
      try {statusResponse=await fetch(`${processorUrl}/jobs/${id}`, { cache: "no-store",signal:controller.signal });}
      catch(error) {if(controller.signal.aborted)return;throw error;}
      if(controller.signal.aborted)return;
      if (!statusResponse.ok) throw new Error("Could not read the saved processing job.");
      const job = await statusResponse.json() as LocalJob;
      if(controller.signal.aborted)return;
      setProgress(jobDisplayProgress(job));
      setProgressDetail(job.progressDetail || "");
      setProcessingJob(job);
      setCurrentStage(job.stage);
      if (job.stage === "attention_required") {
        // This is a saved terminal attention state, not an active reconnect.
        // Let the caller's finally clear its busy flag and unlock navigation.
        setFailureProgress(job.progress);
        setProcessingError(job.error?.message || job.progressDetail || "The saved step needs attention before retrying.");
        return;
      }
      if (job.stage === "failed") {
        setFailureProgress(job.progress);
        throw new Error(job.error?.message || "Video processing failed.");
      }
      if (job.stage === "completed") {
        showCompletedJob(job);
        return;
      }
      if (job.stage === "uploaded" && job.readyToAnalyze) {
        setCurrentJobId(null);
        setSourceJob(null);
        setView("jobs");
        await loadJobs(true);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  }

  function currentEditSettings(): EditSettings {
    const viral = editStyle === "viral_reel";
    return { editStyle, durationMode: "auto", recapBrief, targetDuration: viral ? 36 : editStyle === "complete_highlights" ? 60 : 30, durationMin: editStyle === "complete_highlights" ? 60 : viral ? 30 : 0, aspectRatio: viral ? "4:5" : editStyle === "complete_highlights" ? aspectRatio : "9:16", commentary: editStyle === "complete_highlights" ? true : commentary, playerHighlight: highlight, captions, logoMasking, originalAudio: editStyle === "complete_highlights" ? "muted" : audio, intensity };
  }

  async function analyze() {
    if (!file && !sourceJob) return;
    monitorController.current?.abort();
    setProgress(0);
    setProgressDetail("");
    setProcessingJob(null);
    setCurrentStage("uploading");
    setProcessingError(null);
    setWarnings([]);
    setEditPlan(null);
    setOutputUrl(null);
    if (!resumeUploadJob) setCurrentJobId(null);
    setFailureProgress(0);
    setView("processing");
    const settings = currentEditSettings();
    try {
      const duration=sourceJob?Number(sourceJob.media?.duration||sourceJob.sourceDuration||0):await uploadVideoDuration(file!);
      const durationProblem=sourceDurationProblem(duration);
      if(durationProblem)throw new Error(durationProblem);
      const editSettings = toBase64Url(JSON.stringify(settings));
      if (sourceJob) {
        const startResponse = await fetch(`${processorUrl}/jobs/${sourceJob.id}/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ editSettings }) });
        const created = await startResponse.json() as LocalJob & { error?: string };
        if (!startResponse.ok) throw new Error(created.error || "The editing worker could not start from this saved source.");
        setCurrentJobId(created.id);
        await monitorJob(created.id);
        return;
      }
      const selectedFile = file;
      if (!selectedFile) throw new Error("Choose a video file before starting analysis.");
      const healthResponse = await fetch(`${processorUrl}/health`, { cache: "no-store" });
      const health = healthResponse.ok ? await healthResponse.json() as { uploadMode?: string } : {};
      let created: LocalJob & { error?: string };
      if (health.uploadMode === "resumable") {
        const sessionResponse = await fetch(resumeUploadJob ? `${processorUrl}/jobs/${resumeUploadJob.id}/upload-session` : `${processorUrl}/uploads/resumable`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: selectedFile.name, contentType: selectedFile.type || "video/mp4", size: selectedFile.size, editSettings }),
        });
        const session = await sessionResponse.json() as LocalJob & { error?: string; uploadUrl?: string };
        if (!sessionResponse.ok || !session.uploadUrl) throw new Error(session.error || "Cloud Storage could not start the upload.");
        setCurrentJobId(session.id);
        try {
          await uploadFileInChunks(session.id, session.uploadUrl, selectedFile, setProgress);
        } catch (uploadError) {
          if (!(uploadError instanceof Error) || uploadError.message !== "UPLOAD_SESSION_EXPIRED") throw uploadError;
          const resetResponse = await fetch(`${processorUrl}/jobs/${session.id}/upload-session`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileName: selectedFile.name, size: selectedFile.size, reset: true }),
          });
          const reset = await resetResponse.json() as { uploadUrl?: string; error?: string };
          if (!resetResponse.ok || !reset.uploadUrl) throw new Error(reset.error || "The saved upload session expired and could not be renewed.");
          await uploadFileInChunks(session.id, reset.uploadUrl, selectedFile, setProgress);
        }
        const startResponse = await fetch(`${processorUrl}/jobs/${session.id}/start`, { method: "POST" });
        created = await startResponse.json() as LocalJob & { error?: string };
        if (!startResponse.ok) throw new Error(created.error || "Cloud Run could not start the editing worker.");
        setResumeUploadJob(null);
      } else {
        const response = await fetch(`${processorUrl}/jobs`, {
          method: "POST", body: selectedFile, headers: {
            "Content-Type": selectedFile.type || "video/mp4",
            "X-File-Name": encodeURIComponent(selectedFile.name),
            "X-Edit-Settings": editSettings,
          },
        });
        created = await response.json() as LocalJob & { error?: string };
        if (!response.ok) throw new Error(typeof created.error === "string" ? created.error : "The local processor rejected the upload.");
      }
      setCurrentJobId(created.id);
      await monitorJob(created.id);
    } catch (error) {
      setProcessingError(error instanceof Error ? error.message : "The local processor could not be reached.");
    }
  }

  async function importLinkedSource() {
    if (!importUrl.trim() || !rightsConfirmed || importBusy) return;
    setImportBusy(true);
    setImportError(null);
    setProgress(1);
    setProgressDetail("Starting the background video download...");
    setCurrentStage("importing");
    monitorController.current?.abort();
    setProcessingJob(null);
    setProcessingError(null);
    setView("processing");
    try {
      const response = await fetch(`${processorUrl}/imports/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl.trim(), rightsConfirmed: true, editSettings: toBase64Url(JSON.stringify(currentEditSettings())) }),
      });
      const job = await response.json() as LocalJob & { error?: string };
      if (job.id) setCurrentJobId(job.id);
      if (!response.ok) throw new Error(job.error || "The video download could not start.");
      await monitorJob(job.id);
      await loadJobs(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The video download could not start.";
      setImportError(message);
      setProcessingError(message);
    } finally {
      setImportBusy(false);
    }
  }

  async function resumeProcessing(reselectBlocked=false) {
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
      setCurrentStage(job.stage);
      if (job.stage === "uploading" || (job.stage === "uploaded" && Number(job.progress || 0) < 5)) {
        prepareUploadResume(job);
        return;
      }
      if (job.stage === "completed") {
        showCompletedJob(job);
        return;
      }
      if (["failed","attention_required"].includes(job.stage)) {
        const retryKind = reselectBlocked ? "reselect-blocked" : ["youtube", "remote"].includes(job.sourceKind || "") && !job.importedAt ? "retry-import" : Number(job.progress || failureProgress) >= 84 ? "retry-render" : "retry-analysis";
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
    const sourceName = file?.name || sourceJob?.sourceName;
    if (!sourceName) return;
    const viral = editStyle === "viral_reel";
    const settings: EditSettings = { editStyle, durationMode: "auto", targetDuration: Math.max(editStyle === "complete_highlights" ? 60 : 0, Number(editPlan?.plannedDuration || (viral ? 36 : 60))), durationMin: editStyle === "complete_highlights" ? 60 : viral ? 30 : 0, aspectRatio: viral ? "4:5" : editStyle === "complete_highlights" ? aspectRatio : "9:16", commentary: editStyle === "complete_highlights" ? true : commentary, playerHighlight: highlight, captions, logoMasking, originalAudio: editStyle === "complete_highlights" ? "muted" : audio, intensity };
    const blob = new Blob([JSON.stringify({ version: 2, source: { name: sourceName, duration: sourceDuration }, settings, contentPlan: editPlan, moments: selected }, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${sourceName.replace(/\.[^.]+$/, "")}-touchline-edit-plan.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <main className="app-shell">
      <Sidebar view={view} libraryTab={libraryTab} jobs={jobs} onNew={() => { setResumeUploadJob(null); setSourceJob(null); setCurrentJobId(null); setFile(null); setVideoUrl(null); setImportError(null); setView("upload"); }} onJobs={(tab) => { setLibraryTab(tab); setView("jobs"); }} />
      <section className="workspace" id="new">
        <div className="workspace-bar"><span>Creator workspace <span aria-hidden="true">/</span> <strong>{view === "upload" ? "New edit" : view === "jobs" ? "Video library" : view === "processing" ? "Processing" : "Review & publish"}</strong></span><span className="workspace-badge"><StudioIcon name="shield" /> Private workspace</span></div>
        {view === "jobs" && <JobsView jobs={jobs} tab={libraryTab} onTab={setLibraryTab} loading={jobsLoading} error={jobsError} storageBytes={storageBytes} onRefresh={() => void loadJobs()} onOpen={openSavedJob} onRetry={(job) => void retrySavedJob(job)} onPublished={(job) => void markPublishedJob(job)} onDelete={(job) => void deleteSavedJob(job)} />}
        {view === "upload" && (
          <UploadView
            file={file} videoUrl={videoUrl} inputRef={inputRef} chooseFile={chooseFile} setSourceDuration={setSourceDuration}
            resumeUploadJob={resumeUploadJob} sourceJob={sourceJob} sourceMode={sourceMode} setSourceMode={(value) => { setSourceMode(value); setImportUrl(""); setImportError(null); setFile(null); if (videoUrl?.startsWith("blob:")) URL.revokeObjectURL(videoUrl); setVideoUrl(null); }}
            importUrl={importUrl} setImportUrl={setImportUrl} rightsConfirmed={rightsConfirmed} setRightsConfirmed={setRightsConfirmed}
            importBusy={importBusy} importError={importError} importLinkedSource={() => void importLinkedSource()} clearSource={() => { setSourceJob(null); setVideoUrl(null); setCurrentJobId(null); }}
            editStyle={editStyle} setEditStyle={(value) => { setEditStyle(value); if (value === "complete_highlights" || value === "viral_reel") { setCommentary(true); setAudio(value === "complete_highlights" ? "muted" : "reduced"); } }}
            aspectRatio={aspectRatio} setAspectRatio={setAspectRatio}
            commentary={commentary} setCommentary={setCommentary}
            highlight={highlight} setHighlight={setHighlight} captions={captions} setCaptions={setCaptions} logoMasking={logoMasking} setLogoMasking={setLogoMasking}
            recapBrief={recapBrief} setRecapBrief={setRecapBrief} audio={audio} setAudio={setAudio} intensity={intensity} setIntensity={setIntensity} analyze={analyze}
          />
        )}
        {view === "processing" && <ProcessingView fileName={file?.name ?? processingJob?.sourceName ?? sourceJob?.sourceName ?? (currentStage === "importing" ? "Video source" : "Match footage")} progress={progress} detail={progressDetail} stage={currentStage} job={processingJob} error={processingError} canResume={Boolean(currentJobId)} retrying={retrying} onRetry={() => void resumeProcessing()} onReselect={() => void resumeProcessing(true)} onBack={() => setView("upload")} />}
        {view === "result" && (
          <ResultView file={file} videoUrl={outputUrl || videoUrl} outputUrl={outputUrl} warnings={warnings} selected={selected} allMoments={moments} finalDuration={finalDuration}
            sourceDuration={sourceDuration} videoTitle={typeof editPlan?.title === "string" ? editPlan.title : "Your football story"} editStyle={editStyle} aspectRatio={aspectRatio} downloadPlan={downloadPlan} jobId={currentJobId} />
        )}
      </section>
    </main>
  );
}

function StudioIcon({ name, className = "" }: { name: "plus" | "library" | "video" | "activity" | "upload" | "arrow" | "shield" | "help" | "search" | "grid" | "list" | "refresh" | "check"; className?: string }) {
  const paths: Record<string, string> = {
    plus: "M12 5v14M5 12h14", library: "M4 4h6v16H4zM14 4h6v16h-6zM4 8h6M14 8h6",
    video: "M3 5h18v14H3zM10 9l5 3-5 3z", activity: "M3 12h4l3-7 4 14 3-7h4",
    upload: "M12 16V3M7 8l5-5 5 5M4 15v6h16v-6", arrow: "M4 12h16M14 6l6 6-6 6",
    shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6",
    help: "M9 8a3 3 0 016 0c0 2-3 2-3 5M12 17h.01M12 2a10 10 0 100 20 10 10 0 000-20",
    search: "M10 3a7 7 0 100 14 7 7 0 000-14M15 15l6 6",
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    list: "M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01",
    refresh: "M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0113-3l2 3M19 16a8 8 0 01-13 3l-2-3",
    check: "M5 12l4 4L19 6",
  };
  return <svg className={`studio-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function Sidebar({ view, libraryTab, jobs, onNew, onJobs }: { view: View; libraryTab: LibraryTab; jobs: LocalJob[]; onNew: () => void; onJobs: (tab: LibraryTab) => void }) {
  const [guideOpen, setGuideOpen] = useState(false);
  const guideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!guideOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    guideRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setGuideOpen(false);
      if (event.key === "Tab") {
        event.preventDefault();
        guideRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [guideOpen]);
  const working = jobs.filter(job => !["completed", "failed", "attention_required", "uploaded"].includes(job.stage)).length;
  return <aside className="sidebar">
    <button className="brand brand-button" onClick={onNew} aria-label="Touchline AI home"><span className="brand-mark"><span /></span><span>Touchline<span className="brand-accent">AI</span></span></button>
    <span className="sidebar-label">STUDIO</span>
    <nav className="nav-list" aria-label="Main navigation">
      <button className={`nav-item ${view === "upload" ? "active" : ""}`} aria-current={view === "upload" ? "page" : undefined} onClick={onNew}><StudioIcon name="plus" /> New edit</button>
      <button className={`nav-item ${view === "jobs" && libraryTab === "all" ? "active" : ""}`} onClick={() => onJobs("all")}><StudioIcon name="library" /> All projects {jobs.length > 0 && <b className="nav-count">{jobs.length}</b>}</button>
      <button className={`nav-item ${view === "jobs" && libraryTab === "originals" ? "active" : ""}`} onClick={() => onJobs("originals")}><StudioIcon name="video" /> Original videos</button>
      <button className={`nav-item ${view === "jobs" && libraryTab === "recaps" ? "active" : ""}`} onClick={() => onJobs("recaps")}><StudioIcon name="check" /> Recap edits</button>
      <button className={`nav-item ${view === "jobs" && libraryTab === "queue" ? "active" : ""}`} onClick={() => onJobs("queue")}><StudioIcon name="activity" /> Processing queue {working > 0 && <b className="nav-count">{working}</b>}</button>
      {view !== "upload" && view !== "jobs" && <div className="nav-item active"><StudioIcon name="video" /> Current project</div>}
    </nav>
    <div className="sidebar-spacer" />
    <div className="sidebar-note"><StudioIcon name="shield" /><strong>Your work stays yours.</strong><p>Original footage and finished recaps are kept in separate libraries.</p></div>
    <button className="nav-item sidebar-button" onClick={() => setGuideOpen(true)}><StudioIcon name="help" /> Processing guide</button>
    <div className="account-card"><div className="avatar">T</div><div><strong>Creator workspace</strong><span>Football video studio</span></div></div>
    {guideOpen && <div className="guide-backdrop" onClick={() => setGuideOpen(false)}><section ref={guideRef} className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title" onClick={event => event.stopPropagation()}><div className="guide-heading"><StudioIcon name="help" /><h2 id="guide-title">From footage to finished recap</h2></div><ol><li><strong>Upload your original</strong><p>Keep your browser open until the upload finishes. Find the saved source in Original videos.</p></li><li><strong>Select, split, and track</strong><p>Complete actions are chosen first, then each scene gets its own player-and-ball camera path.</p></li><li><strong>Review and publish</strong><p>Effects, captions, and narration are added. Review the video, copy its title, or upload privately to one connected YouTube channel.</p></li></ol><p>Temporary Google service errors retry automatically. If a job needs attention, open its saved error and use Resume; no new upload is needed once the source is stored.</p><button className="primary-button" onClick={() => setGuideOpen(false)}>Got it</button></section></div>}
  </aside>;
}

export function JobsView({ jobs, tab = "all", onTab = () => {}, loading, error, storageBytes, onRefresh, onOpen, onRetry, onPublished, onDelete }: {
  jobs: LocalJob[]; loading: boolean; error: string | null; storageBytes: number;
  tab?: LibraryTab; onTab?: (tab: LibraryTab) => void;
  onRefresh: () => void; onOpen: (job: LocalJob) => void; onRetry: (job: LocalJob) => void; onPublished: (job: LocalJob) => void; onDelete: (job: LocalJob) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [layout, setLayout] = useState("grid");
  const matches = jobs.filter(job => `${job.sourceName || ""} ${job.editPlan?.title || ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === "name" ? (a.sourceName || "").localeCompare(b.sourceName || "") : Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
  const working = matches.filter((job) => !["completed", "failed", "attention_required"].includes(job.stage) && !(job.stage === "uploaded" && job.readyToAnalyze));
  const failed = matches.filter((job) => ["failed","attention_required"].includes(job.stage));
  const completed = matches.filter((job) => job.stage === "completed");
  const originals = matches.filter((job) => Boolean(job.sourceName) && !job.retention?.sourceDeleted);
  return <div className={`jobs-page library-${layout}`}>
    <header className="topbar jobs-topbar"><div><div className="eyebrow">YOUR WORKSPACE</div><h1>Video library</h1><p className="page-description">Your footage, your edits. Everything in one place.</p></div><button className="secondary-button" disabled={loading} onClick={onRefresh}><StudioIcon name="refresh" /> {loading ? "Refreshing…" : "Refresh"}</button></header>
    <section className="storage-summary" aria-label="Cloud storage summary">
      <div><StudioIcon name="library" /><span className="mini-label">STORED PROJECTS</span><strong>{jobs.length}</strong><small>Originals and saved edits</small></div>
      <div><StudioIcon name="check" /><span className="mini-label">COMPLETED EDITS</span><strong>{jobs.filter(job => job.stage === "completed").length}</strong><small>Ready to review and publish</small></div>
      <div><StudioIcon name="activity" /><span className="mini-label">PROCESSING</span><strong>{jobs.filter(job => !["completed", "failed", "attention_required", "uploaded"].includes(job.stage)).length}</strong><small>Saved work in progress</small></div>
      <div><StudioIcon name="shield" /><span className="mini-label">STORED MEDIA</span><strong>{formatBytes(storageBytes)}</strong><small>Managed retention</small></div>
    </section>
    <div className="library-toolbar"><div className="library-tabs" role="tablist" aria-label="Video library"><button role="tab" aria-selected={tab === "all"} onClick={() => onTab("all")}>All projects</button><button role="tab" aria-selected={tab === "originals"} onClick={() => onTab("originals")}>Original videos</button><button role="tab" aria-selected={tab === "recaps"} onClick={() => onTab("recaps")}>Recap edits</button><button role="tab" aria-selected={tab === "queue"} onClick={() => onTab("queue")}>Processing</button></div><div className="library-controls"><label className="library-search"><StudioIcon name="search" /><input aria-label="Search videos" placeholder="Search videos…" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="Sort videos" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest first</option><option value="name">Name A–Z</option></select><div className="layout-switch"><button aria-label="Grid view" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><StudioIcon name="grid" /></button><button aria-label="List view" aria-pressed={layout === "list"} onClick={() => setLayout("list")}><StudioIcon name="list" /></button></div></div></div>
    {error && <p className="jobs-error" role="alert">{error}</p>}
    {!loading && jobs.length > 0 && query && matches.length === 0 && <div className="search-empty" role="status"><span>No videos match “{query}”.</span><button className="secondary-button" onClick={() => setQuery("")}>Clear search</button></div>}
    {loading ? <div className="jobs-empty">Loading saved projects…</div> : jobs.length === 0 ? <div className="jobs-empty"><strong>No saved projects yet</strong><span>Your uploaded, working and completed edits will appear here on every device.</span></div> : <>
      {(tab === "all" || tab === "originals") && <section className="library-section original-library" aria-labelledby="original-library-title">
        <div className="library-head"><div><span className="mini-label">SOURCE LIBRARY</span><h2 id="original-library-title">Original videos</h2><p>Uploaded and downloaded match footage stays here independently from your recaps.</p></div><span className="library-count">{originals.length}</span></div>
        {originals.length === 0 ? <p className="job-group-empty">No original videos saved.</p> : <div className="job-list original-video-grid">{originals.map((job) => <OriginalVideoCard key={job.id} job={job} onOpen={onOpen} onRetry={onRetry} onDelete={onDelete} />)}</div>}
      </section>}
      {(tab === "all" || tab === "recaps") && <section className="library-section recap-library" aria-labelledby="recap-library-title">
        <div className="library-head"><div><span className="mini-label">EDIT LIBRARY</span><h2 id="recap-library-title">Recap edits</h2><p>Finished analytical recaps, ready to watch, download, or publish.</p></div><span className="library-count">{completed.length}</span></div>
        <JobGroup title="Recap edits" jobs={completed} empty="No finished recap videos yet." onOpen={onOpen} onRetry={onRetry} onPublished={onPublished} onDelete={onDelete} />
      </section>}
      {(tab === "all" || tab === "queue") && <section className="job-groups status-library" aria-label="Source processing status">
        <JobGroup title="Working" jobs={working} empty="No videos are processing." onOpen={onOpen} onRetry={onRetry} onPublished={onPublished} onDelete={onDelete} />
        <JobGroup title="Needs attention" jobs={failed} empty="No failed jobs." onOpen={onOpen} onRetry={onRetry} onPublished={onPublished} onDelete={onDelete} />
      </section>}
    </>}
    <details className="retention-note"><summary><StudioIcon name="shield" /> Storage &amp; retention policy</summary><p>Failed files are retained for 3 days. Unpublished videos are retained for 14 days. After a verified YouTube upload, the source is removed after 24 hours and the finished MP4 after 7 days. Delete removes the whole stored project, including its original and recap.</p></details>
  </div>;
}

function OriginalVideoCard({ job, onOpen, onRetry, onDelete }: { job: LocalJob; onOpen: (job: LocalJob) => void; onRetry: (job: LocalJob) => void; onDelete: (job: LocalJob) => void }) {
  const ready = job.stage === "uploaded" && job.readyToAnalyze;
  const failed = ['failed','attention_required'].includes(job.stage);
  const completed = job.stage === "completed";
  const status = completed ? "Source retained · recap complete" : failed ? "Source retained · needs attention" : ready ? "Source secured · ready to edit" : "Source secured · processing";
  return <article className="original-video-card">
    <div className="original-video-media"><video src={`${processorUrl}/sources/${job.id}`} preload="metadata" muted aria-label={`Preview of ${job.sourceName || "original football video"}`} /><a className="original-video-preview" href={`${processorUrl}/sources/${job.id}`} target="_blank" rel="noreferrer">Preview original <span aria-hidden="true">→</span></a></div>
    <div className="original-video-details"><span className="source-ready-badge">{status}</span><h3>{job.sourceName || "Original football video"}</h3><p>{job.sourceSize ? formatBytes(job.sourceSize) : "Cloud source"} · {formatJobDate(job.updatedAt || job.createdAt)}</p><div className="original-video-actions">{ready && <button className="primary-compact" onClick={() => onOpen(job)}>Analyze &amp; edit</button>}{failed && <button className="secondary-button" onClick={() => onRetry(job)}>Resume</button>}{!ready && !failed && !completed && <button className="secondary-button" onClick={() => onOpen(job)}>View progress</button>}<button className="danger-button" onClick={() => onDelete(job)}>Delete project</button></div></div>
  </article>;
}

function JobGroup({ title, jobs, empty, onOpen, onRetry, onPublished, onDelete }: { title: string; jobs: LocalJob[]; empty: string; onOpen: (job: LocalJob) => void; onRetry: (job: LocalJob) => void; onPublished: (job: LocalJob) => void; onDelete: (job: LocalJob) => void }) {
  return <section className="job-group"><div className="job-group-head"><h2>{title}</h2><span>{jobs.length}</span></div>{jobs.length === 0 ? <p className="job-group-empty">{empty}</p> : <div className={title === "Ready to edit" ? "job-list ready-source-grid" : "job-list"}>{jobs.map((job) => <JobCard key={job.id} job={job} onOpen={onOpen} onRetry={onRetry} onPublished={onPublished} onDelete={onDelete} />)}</div>}</section>;
}

function JobCard({ job, onOpen, onRetry, onPublished, onDelete }: { job: LocalJob; onOpen: (job: LocalJob) => void; onRetry: (job: LocalJob) => void; onPublished: (job: LocalJob) => void; onDelete: (job: LocalJob) => void }) {
  const workflow=job.workflow||buildWorkflowProgress(job);
  const jobStep=workflow.steps.find(step=>step.id===workflow.phase);
  const completed = job.stage === "completed";
  const failed = ['failed','attention_required'].includes(job.stage);
  const ready = job.stage === "uploaded" && job.readyToAnalyze;
  const title = completed && typeof job.editPlan?.title === "string" ? job.editPlan.title : job.sourceName || `Football project ${job.id.slice(0, 8)}`;
  const uploadIncomplete = job.stage === "uploading" || (job.stage === "uploaded" && Number(job.progress || 0) < 5);
  const deletionDate = job.retention?.outputDeleteAt ? new Date(job.retention.outputDeleteAt) : null;
  if (ready) return <article className="downloaded-source-card">
    <div className="downloaded-source-media">
      {job.sourceThumbnailUrl ? <img src={job.sourceThumbnailUrl} alt="" loading="lazy" /> : <video src={`${processorUrl}/sources/${job.id}`} preload="metadata" muted aria-label={`Preview of ${job.sourceName || "downloaded video"}`} />}
      <button className="downloaded-source-overlay" onClick={() => onOpen(job)} aria-label={`Preview and analyze ${job.sourceName || "downloaded video"}`}>Preview &amp; analyze <span aria-hidden="true">→</span></button>
    </div>
    <div className="downloaded-source-details"><span className="source-ready-badge">Downloaded · ready to edit</span><h3>{job.sourceName || "Downloaded football video"}</h3><p>{job.sourceSize ? formatBytes(job.sourceSize) : "Saved source"} · {formatJobDate(job.importedAt || job.updatedAt || job.createdAt)}</p><button className="danger-button" onClick={() => onDelete(job)}>Delete download</button></div>
  </article>;
  return <article className={`job-card job-${job.stage}`}>
    {completed && job.outputUrl && !job.retention?.outputDeleted && <button className="recap-thumbnail" onClick={() => onOpen(job)} aria-label={`Watch ${title}`}><video src={`${processorUrl}/outputs/${job.id}/final.mp4`} preload="metadata" muted playsInline /><span><StudioIcon name="video" /> Watch recap</span></button>}
    <button className="job-card-main" onClick={() => onOpen(job)}>
      <span className="job-status"><i /> {completed ? "Completed" : failed ? "Needs attention" : ready ? "Ready to edit" : ['uploading','importing','queued','downloading','restoring'].includes(job.stage)?cloudStageLabel(job.stage):`Step ${jobStep?.number||1} · ${jobStep?.title||'Select & split source scenes'}`}</span>
      <strong>{title}</strong>
      <small>{job.progressDetail || (completed ? "Your edited video is ready." : failed ? job.error?.message || "Open this project to retry." : uploadIncomplete ? "Select the same file to continue the saved upload." : "Cloud processing continues in the background.")}</small>
      {!completed && !failed && !ready && <span className="job-progress"><i style={{ width: `${Math.max(2, job.progress || 0)}%` }} /></span>}
      <span className="job-meta">{job.sourceSize ? formatBytes(job.sourceSize) : "Cloud job"} · {formatJobDate(job.updatedAt || job.createdAt)}{deletionDate && (completed || failed) ? ` · Media ${job.retention?.outputDeleted ? "removed" : `kept until ${deletionDate.toLocaleDateString()}`}` : ""}</span>
    </button>
    <div className="job-actions">
      <button className={ready ? "primary-compact" : "secondary-button"} onClick={() => onOpen(job)}>{completed ? "Watch video" : failed ? "View error" : ready ? "Analyze & edit" : uploadIncomplete ? "Continue upload" : "View progress"}</button>
      {failed && <button className="primary-compact" onClick={() => onRetry(job)}>Resume</button>}
      {completed && !job.retention?.published && <button className="primary-compact" onClick={() => onPublished(job)}>Mark published</button>}
      {completed && job.retention?.published && <span className="published-badge">Published · cleanup scheduled</span>}
      {(completed || failed || ready) && <button className="danger-button" onClick={() => onDelete(job)}>Delete</button>}
    </div>
  </article>;
}

type UploadProps = {
  file: File | null; videoUrl: string | null; inputRef: React.RefObject<HTMLInputElement | null>;
  resumeUploadJob: LocalJob | null; sourceJob: LocalJob | null;
  sourceMode: "file" | "youtube"; setSourceMode: (value: "file" | "youtube") => void;
  importUrl: string; setImportUrl: (value: string) => void; rightsConfirmed: boolean; setRightsConfirmed: (value: boolean) => void;
  importBusy: boolean; importError: string | null; importLinkedSource: () => void; clearSource: () => void;
  chooseFile: (file: File | undefined) => void; setSourceDuration: (value: number) => void;
  editStyle: EditStyle; setEditStyle: (value: EditStyle) => void;
  aspectRatio: OutputRatio; setAspectRatio: (value: OutputRatio) => void;
  commentary: boolean; setCommentary: (value: boolean) => void;
  highlight: boolean; setHighlight: (value: boolean) => void; captions: boolean; setCaptions: (value: boolean) => void;
  logoMasking: boolean; setLogoMasking: (value: boolean) => void;
  recapBrief: string; setRecapBrief: (value: string) => void;
  audio: AudioMode; setAudio: (value: AudioMode) => void; intensity: Intensity; setIntensity: (value: Intensity) => void; analyze: () => void;
};

function UploadView(props: UploadProps) {
  const { file, videoUrl, inputRef, chooseFile, setSourceDuration, resumeUploadJob, sourceJob, sourceMode, setSourceMode, importUrl, setImportUrl, rightsConfirmed, setRightsConfirmed, importBusy, importError, importLinkedSource, clearSource, editStyle, setEditStyle, aspectRatio, setAspectRatio, commentary, setCommentary, highlight, setHighlight, captions, setCaptions, logoMasking, setLogoMasking, recapBrief, setRecapBrief, audio, setAudio, intensity, setIntensity, analyze } = props;
  const viral = editStyle === "viral_reel";
  const complete = editStyle === "complete_highlights";
  const outputRatio = viral ? "4:5" : complete ? aspectRatio : "9:16";
  const [dragging, setDragging] = useState(false);
  return <>
    <header className="topbar"><div><div className="eyebrow">FOOTBALL, WITH YOUR POINT OF VIEW</div><h1>{resumeUploadJob ? "Continue your upload" : "Create a football edit"}</h1><p className="page-description">Turn match footage into a story worth watching.</p></div><div className="step-indicator"><span>1</span> Upload & settings</div></header>
    {resumeUploadJob && <div className="resume-upload-banner"><strong>Upload paused safely</strong><span>Select the same file—{resumeUploadJob.sourceName}—to continue from the last confirmed cloud byte.</span></div>}
    <div className="content-grid">
      <section className="upload-column">
        <div className="panel-heading"><div><span className="mini-label">01 / YOUR FOOTAGE</span><h2>Start with the original</h2></div><span className="subtle-badge">MP4 · MOV · WebM</span></div>
        {!resumeUploadJob && !sourceJob && <div className="source-tabs" role="tablist" aria-label="Choose source type"><button role="tab" aria-selected={sourceMode === "file"} className={sourceMode === "file" ? "selected" : ""} onClick={() => setSourceMode("file")}><StudioIcon name="upload" /> Upload file</button><button role="tab" aria-selected={sourceMode === "youtube"} className={sourceMode === "youtube" ? "selected" : ""} onClick={() => setSourceMode("youtube")}><StudioIcon name="video" /> YouTube link</button></div>}
        {sourceJob && <div className="source-ready-card">
          {videoUrl && <video className="source-preview" src={videoUrl} controls muted preload="metadata" poster={sourceJob.sourceThumbnailUrl} onLoadedMetadata={(event) => setSourceDuration(event.currentTarget.duration)} />}
          <span className="source-ready-badge">Downloaded and verified</span><h2>{sourceJob.sourceName}</h2><p>{sourceJob.sourceSize ? formatBytes(sourceJob.sourceSize) : "Cloud source"} · Ready for analysis</p>
          <div className="source-ready-actions">{sourceJob.sourcePageUrl && <a href={sourceJob.sourcePageUrl} target="_blank" rel="noreferrer">Open original link</a>}<button className="choose-button" onClick={clearSource}>Choose another source</button></div>
        </div>}
        {sourceMode !== "file" && !resumeUploadJob && !sourceJob && <div className="link-import-card">
          <div className="link-import-icon">▶</div><span className="mini-label">BACKGROUND CLOUD IMPORT</span><h2>Download an authorized YouTube source</h2><p>The cloud downloads and verifies the video before editing. Analysis starts only after you review the saved video.</p>
          <label className="link-field"><span>YouTube video URL</span><input type="url" value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." autoComplete="off" /></label>
          <label className="rights-confirm"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} /><span>I own this video, have permission, or am otherwise legally authorized to use it.</span></label>
          {importError && <p className="import-error" role="alert">{importError}</p>}
          <button className="primary-button" disabled={!importUrl.trim() || !rightsConfirmed || importBusy} onClick={importLinkedSource}>{importBusy ? "Starting import..." : "Download to source library"} <span>→</span></button>
          <small className="file-hint">Original video: minimum 3 minutes · up to 1080p and 2 GB · playlists are not imported</small>
        </div>}
        <div className={`dropzone ${file ? "has-file" : ""} ${dragging ? "dragging" : ""}`} hidden={Boolean(sourceJob) || (sourceMode !== "file" && !resumeUploadJob)} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}>
          <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm" hidden onChange={(event) => chooseFile(event.target.files?.[0])} />
          <small className="file-hint">Original match video must be at least 3 minutes long.</small>
          {file && videoUrl ? <video className="source-preview" src={videoUrl} controls muted preload="metadata" onLoadedMetadata={(event) => setSourceDuration(event.currentTarget.duration)} /> : <div className="upload-symbol"><StudioIcon name="upload" /></div>}
          {file ? <><h2>{file.name}</h2><p>{formatBytes(file.size)} · Ready to upload</p><button className="choose-button" onClick={() => inputRef.current?.click()}>Replace video</button></> : <><h2>{resumeUploadJob ? "Select the same match video" : "Drop your match footage here"}</h2><p>{resumeUploadJob ? "The cloud will verify the file and continue from its saved offset." : "We’ll scan the full video and find the moments worth watching."}</p><button className="choose-button" onClick={() => inputRef.current?.click()}>{resumeUploadJob ? "Select video to continue" : "Choose video"}</button><span className="file-hint">MP4, MOV or WebM · up to 2 GB</span></>}
        </div>
        <div className="trust-row"><span><i>✓</i> Full-video analysis</span><span><i>✓</i> Private processing</span><span><i>✓</i> One finished edit</span></div>
        <div className={`format-preview ${viral ? "reel-format" : ""}`}><div className="phone-frame" style={{ aspectRatio: outputRatio.replace(":", "/") }}><div className="pitch-lines"><span>{outputRatio}</span></div></div><div><span className="mini-label">OUTPUT FORMAT</span><h3>{complete ? `${outputRatio} complete match recap` : `${outputRatio} ${viral ? "football reel" : "tactical analysis"}`}</h3><p>Complete actions, original narration, and evidence-led player highlights. Review the finished edit before publishing.</p><div className="spec-row"><span>{outputRatio === "16:9" ? "1920 × 1080" : outputRatio === "4:5" ? "1080 × 1350" : outputRatio === "1:1" ? "1080 × 1080" : outputRatio === "4:3" ? "1440 × 1080" : "1080 × 1920"}</span><span>{complete ? "Natural · evidence-led" : "AI-selected length"}</span><span>MP4</span></div></div></div>
        <section className="how-it-works" aria-labelledby="how-it-works-title"><span className="mini-label">A CLEAR PATH TO YOUR FINISHED VIDEO</span><h3 id="how-it-works-title">You bring the match. We build the edit.</h3><ol><li><span>01</span><strong>Choose the action</strong><p>Goals, chances, and saves—with their complete result.</p></li><li><span>02</span><strong>Frame the story</strong><p>Scene-by-scene tracking, captions, and tactical effects.</p></li><li><span>03</span><strong>Make it yours</strong><p>Original commentary, a finished MP4, and publishing tools.</p></li></ol></section>
      </section>
      <aside className="settings-card" aria-label="Edit settings">
        <div className="settings-heading"><div><span className="mini-label">02 / MAKE IT YOURS</span><h2>Edit settings</h2></div><button className="reset-button" onClick={() => { setEditStyle("complete_highlights"); setAspectRatio("9:16"); setCommentary(true); setHighlight(true); setCaptions(true); setLogoMasking(true); setAudio("muted"); setIntensity("dynamic"); setRecapBrief(""); }}>Reset</button></div>
        <Setting label="Edit style" note="Choose the storytelling system"><div className="segmented two">{(["complete_highlights", "tactical_analysis"] as EditStyle[]).map((value) => <button key={value} className={editStyle === value ? "selected" : ""} onClick={() => { setEditStyle(value); if (value === "complete_highlights") { setCommentary(true); setAudio("muted"); } }}>{value === "complete_highlights" ? "Analysis recap" : "Tactical"}</button>)}</div></Setting>
        {complete && <Setting label="Recap request" note="Optional · natural language"><textarea aria-label="Recap request" className="recap-brief" value={recapBrief} maxLength={320} rows={3} onChange={(event) => setRecapBrief(event.target.value)} placeholder="Create a 2-minute recap covering every goal and explain why the result happened." /><small className="recap-hint">Describe any match, duration, score or angle. Teams, scores and players are verified externally before use.</small></Setting>}
        <Setting label="Recap length" note={complete ? "At least 60 seconds" : "AI-selected length"}><p>{complete ? "Plans at least one minute of complete goals, chances and saves before tracking. Keeps match order and removes duplicate angles and downtime." : "AI chooses the best complete moments and lets the story set the length."}</p></Setting>
        <Setting label="Aspect ratio" note={complete ? "9:16 is the default; tracking follows the action" : "Portrait tactical output"}><div className="segmented four">{(["9:16", "16:9", "4:3", "1:1"] as OutputRatio[]).map((value) => <button key={value} disabled={!complete} className={(complete ? aspectRatio : "9:16") === value ? "selected" : ""} onClick={() => setAspectRatio(value)}>{value}</button>)}</div><small className="recap-hint">9:16 fills a phone screen. The tracker keeps the ball and active player together. 16:9 remains available when the source is too wide.</small></Setting>
        <div className="toggle-group"><Toggle label="AI commentary" detail={complete ? "Required evidence-specific criticism and analysis" : viral ? "Short analysis mixed over quieter match sound" : "Replaces the source audio with analysis narration"} checked={complete || commentary} disabled={complete} onChange={(value) => { setCommentary(value); if (value) setAudio(viral ? "reduced" : "muted"); }} /><Toggle label="Player highlight" detail="Large thick red circle on the verified active player only" checked={highlight} onChange={setHighlight} /><Toggle label="Captions" detail="Sparse bold story captions" checked={captions} onChange={setCaptions} /><Toggle label="Logo / watermark masking" detail="Blur authorized persistent overlays" checked={logoMasking} onChange={setLogoMasking} /></div>
        <Setting label="Source audio" note={complete ? "Broadcast commentary and source music are always removed" : commentary ? (viral ? "Ducked beneath the analysis voice" : "Muted while AI commentary is enabled") : "Match sound level"}><div className="segmented three">{(["normal", "reduced", "muted"] as AudioMode[]).map((value) => <button key={value} disabled={complete || (!viral && commentary)} className={(complete ? value === "muted" : audio === value) ? "selected" : ""} onClick={() => setAudio(value)}>{titleCase(value)}</button>)}</div></Setting>
        <Setting label="Editing intensity" note="Pacing and effects"><div className="segmented three">{(["natural", "dynamic", "high_energy"] as Intensity[]).map((value) => <button key={value} className={intensity === value ? "selected" : ""} onClick={() => setIntensity(value)}>{value === "high_energy" ? "High energy" : titleCase(value)}</button>)}</div></Setting>
        <button className="primary-button" disabled={!file && !sourceJob} onClick={analyze}>{resumeUploadJob ? "Continue upload" : sourceJob ? "Analyze & edit downloaded video" : "Analyze football video"} <StudioIcon name="arrow" /></button>
        <p className="consent">Only upload footage you own, have licensed, or are legally permitted to use. Editing effects cannot guarantee fair use or prevent platform claims.</p>
      </aside>
    </div>
  </>;
}

export function ProcessingView({ fileName, progress, detail, stage, job, error, canResume, retrying, onRetry, onReselect, onBack }: { fileName: string; progress: number; detail: string; stage: CloudJobStage; job: LocalJob | null; error: string | null; canResume: boolean; retrying: boolean; onRetry: () => void; onReselect?: () => void; onBack: () => void }) {
  const workflow=job?.workflow||buildWorkflowProgress(job||{stage});
  const currentStep=workflow.steps.find(step=>['active','waiting','paused'].includes(step.status));
  const uploadStage=['uploading','uploaded','importing','queued','downloading','restoring'].includes(stage);
  const heading=stage==='attention_required'?'Saved work needs attention':error?(job?.stage==='failed'?'Processing needs attention':'Connection interrupted')
    :workflow.waiting?'Saved step — retrying automatically':uploadStage?cloudStageLabel(stage):currentStep?.title||'Building your edit';
  const cropPercent=workflow.selectedCount?Math.round(workflow.verified/workflow.selectedCount*100):0;
  const statusLabels:Record<string,string>={pending:'Waiting',tracking:'Tracking ball & player',repairing:'Repairing camera',verified:'Keyframes verified',needs_repair:'Needs camera repair'};
  return <div className="processing-page">
    <header className="topbar"><div><div className="eyebrow"><span className="pulse-dot" /> PROCESSING PROJECT</div><h1>Your edit, step by step</h1></div><div className="step-indicator"><span>{currentStep?.number||1}</span> Live workflow</div></header>
    <section className="workflow-status" aria-label="Current processing status"><span className="mini-label">{fileName}</span><h2>{heading}</h2><p role="status" aria-live="polite">{error||detail||currentStep?.detail||'Waiting for the saved job status.'}</p>
      {uploadStage&&<p className="workflow-help">{stage==='uploading'?'Keep this page open until the upload finishes. Editing can continue in the cloud afterwards.':'The source and saved processing state are being prepared.'}</p>}
      {workflow.waiting&&<p className="workflow-help">{workflow.selectedCount?'Your selected scenes and completed keyframes are saved.':'Completed source observations are saved; scene selection is still in progress.'} No Resume click is needed.{workflow.retryAt&&` Next retry: ${new Date(workflow.retryAt).toLocaleTimeString()}.`}</p>}
      {(error||stage==='attention_required')&&<div className="retry-actions"><button className="primary-compact" disabled={retrying} onClick={onRetry}>{retrying?'Reconnecting…':['failed','attention_required'].includes(stage)?'Retry saved step after repair':'Reconnect to saved job'}</button><button className="secondary-button" disabled={retrying} onClick={onBack}>Back to studio</button></div>}
      {stage==='attention_required'&&workflow.selectedCount>0&&onReselect&&<div className="retry-actions"><button className="secondary-button" disabled={retrying} onClick={onReselect}>Choose clearer blocked actions</button><p className="workflow-help">Revises only unverified source clips. Keeps approved crops and every awarded goal.</p></div>}
      <div className="workflow-overall"><span>Overall estimate</span><span>{Math.max(0,Math.min(100,progress))}%</span></div><div className="progress-track"><span style={{width:`${Math.max(0,Math.min(100,progress))}%`}}/></div>
    </section>
    <div className="workflow-layout">
      <nav className="workflow-steps" aria-label="Editing workflow"><ol>{workflow.steps.map(step=><li key={step.id} className={`workflow-step ${step.status}`} aria-current={step.id===workflow.phase?'step':undefined}><span className="workflow-step-number">{step.status==='complete'?'✓':step.number}</span><div><strong>{step.title}</strong><small>{step.detail}</small><span className="workflow-step-state">{step.status==='complete'?'Complete':step.status==='active'?'In progress':step.status==='waiting'?'Waiting — auto retry':step.status==='paused'?'Needs attention':step.status==='skipped'?'Not requested':'Not started'}</span></div></li>)}</ol></nav>
      <section className="scene-queue" aria-labelledby="scene-queue-title"><div className="scene-queue-heading"><div><span className="eyebrow">SELECTED SOURCE SCENES</span><h2 id="scene-queue-title">{workflow.selectedCount?`${workflow.selectedCount} scenes in your edit`:'Choosing complete actions'}</h2></div><span className="source-ready-badge">{job?.settings?.aspectRatio||'9:16'} output</span></div>
        <div className="workflow-metrics"><div><strong>{workflow.selectedCount||'—'}</strong><span>Selected scenes</span></div><div><strong>{formatTime(workflow.selectedDuration)}</strong><span>Selected source length</span></div><div><strong>{workflow.sourcePrepared}/{workflow.selectedCount}</strong><span>Separate clips saved</span></div><div><strong>{workflow.verified}/{workflow.selectedCount}</strong><span>Keyframes verified</span></div></div>
        {workflow.phase==='split'&&Boolean(workflow.sourceVerifiedCount)&&<p className="workflow-help">{workflow.sourceVerifiedCount} source-verified actions · {(workflow.sourceVerifiedDuration||0).toFixed(1)}s reviewed. Separate clips are saved after complete goal coverage and scene selection pass; 9:16 tracking has not started.</p>}
        {Boolean(workflow.sections?.length)&&<div className="section-coverage"><h3>Source section coverage</h3><p className="workflow-help">Targets are flexible, not required per section. Actions crossing a section boundary are counted once in the section containing their midpoint. These are source actions, not saved clips or verified keyframes.</p><ol className="scene-queue-list">{workflow.sections!.map(section=><li className="scene-queue-row" key={section.index}><div className="scene-number">{section.index}</div><div className="scene-information"><strong>Source {formatTime(section.startTime)} – {formatTime(section.endTime)}</strong><span>{section.sceneCount?`${section.sceneCount} ${workflow.selectedCount?'selected':'source-verified'} actions · ${section.selectedSeconds.toFixed(1)}s footage`:'No verified action counted in this section yet'}</span></div><div className="scene-state"><small>Flexible target</small><strong>{section.targetSeconds.toFixed(1)}s</strong></div></li>)}</ol></div>}
        {workflow.selectedCount>0?<><div className="workflow-overall"><span>Separate scene clips — keyframes verified</span><span>{workflow.verified} of {workflow.selectedCount}</span></div><div className="progress-track"><span style={{width:`${cropPercent}%`}}/></div><p className="workflow-help">Each selected action remains its own original-frame clip. Each scene gets its own 9:16 camera path; scenes are combined only during final rendering after effects, transitions, captions and narration.</p><ol className="scene-queue-list">{workflow.scenes.map(scene=><li key={scene.id} className={`scene-queue-row ${scene.status}`}><div className="scene-number">{scene.index}</div><div className="scene-information"><strong>{scene.eventType.replace(/_/g,' ')}</strong><span>Separate source clip · {formatTime(scene.startTime)} – {formatTime(scene.endTime)} · {scene.duration.toFixed(2)}s</span>{scene.description&&<p>{scene.description}</p>}<small>{scene.sourcePrepared?'Separate original-frame clip saved':'Saving separate original-frame clip'} · Local keyframe clock starts at 0:00</small>{scene.detail&&<details><summary>{scene.status==='verified'?'Saved verification':'Current scene details'}</summary><p>{scene.detail}</p></details>}</div><div className="scene-state"><span className={`scene-status ${scene.status}`}>{statusLabels[scene.status]||'Waiting'}</span>{scene.round>0&&scene.status!=='verified'&&<small>Camera pass {scene.round}</small>}</div></li>)}</ol></>:<div className="scene-queue-empty"><strong>Separate scene cards appear after selection.</strong><p>The source is reviewed for complete actions first. Each chosen action is saved separately; no combined video is created until final rendering.</p></div>}</section>
    </div>
  </div>;
}

type ResultProps = { file: File | null; videoUrl: string | null; outputUrl: string | null; warnings: string[]; selected: FootballMoment[]; allMoments: FootballMoment[]; finalDuration: number; sourceDuration: number; videoTitle: string; editStyle: EditStyle; aspectRatio: OutputRatio; downloadPlan: () => void; jobId: string | null };

export function ResultView({ file, videoUrl, outputUrl, warnings, selected, allMoments, finalDuration, sourceDuration, videoTitle, editStyle, aspectRatio, downloadPlan, jobId }: ResultProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState<"title" | "hashtags" | "all" | null>(null);
  const [measuredDuration, setMeasuredDuration] = useState(0);
  const outputRatio = editStyle === "viral_reel" ? "4:5" : aspectRatio;
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
        <div className="preview-stage"><div className={`vertical-video ${outputRatio === "16:9" ? "landscape-video" : ""}`} style={{ aspectRatio: outputRatio.replace(":", "/") }}>{videoUrl ? <video ref={videoRef} src={videoUrl} controls playsInline onLoadedMetadata={event => setMeasuredDuration(event.currentTarget.duration)}><track kind="captions" label="Captions are included when generated" /></video> : <div className="video-fallback">Preview unavailable</div>}</div></div>
        <div className="preview-note"><span className="status-pill"><i /> Render complete</span><span>{outputUrl ? `${outputRatio} MP4 · ${formatTime(measuredDuration || finalDuration)} · Ready to review` : "Rendered preview unavailable."}</span></div>
        {warnings.map((warning) => <div className="preview-note" key={warning}><span>{warning}</span></div>)}
      </section>
      <aside className="timeline-panel">
        <div className="timeline-head"><div><span className="mini-label">SELECTED MOMENTS</span><h2>{selected.length} moments · {formatTime(finalDuration)}</h2></div><span className="duration-target">Adaptive · every verified goal</span></div>
        <div className="timeline-bar">{selected.map((moment) => <button key={moment.id} style={{ flex: moment.endTime - moment.startTime }} className={`bar-${moment.eventType}`} onClick={() => seek(moment)} title={moment.description} aria-label={`View ${moment.eventType.replaceAll("_", " ")}: ${moment.description}`} />)}</div>
        <div className="moment-list">{allMoments.map((moment, index) => <article key={moment.id} className={`moment-card ${moment.selectedForFinalVideo ? "" : "removed"}`}>
          <button aria-label={`View moment ${index + 1}: ${moment.description}`} className="moment-thumb" onClick={() => seek(moment)}><span>{index + 1}</span><i>▶</i></button>
          <button className="moment-main" onClick={() => seek(moment)}><span><b>{formatTime(moment.startTime)}–{formatTime(moment.endTime)}</b><em>{moment.eventType.replaceAll("_", " ")}</em></span><strong>{moment.description}</strong><small>{moment.commentary ?? "No commentary generated"}</small></button>
          <div className="score"><b>{moment.importanceScore}</b><small>SCORE</small></div>
        </article>)}</div>
        <div className="summary-strip"><span><small>SOURCE</small><b>{formatTime(sourceDuration)}</b></span><span><small>FINAL</small><b>{formatTime(measuredDuration || finalDuration)}</b></span><span><small>FORMAT</small><b>{outputRatio} MP4</b></span></div>
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
    <div className="render-banner"><div><span className="mini-label">PRIVATE CLOUD OUTPUT</span><strong>{file?.name || videoTitle}</strong><p>The source, job status and finished video are stored privately in your Google Cloud project and follow the retention policy shown in Projects.</p></div>{outputUrl ? <a href={outputUrl} download>Download MP4</a> : <button onClick={downloadPlan}>Export JSON plan</button>}</div>
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
      const data = await response.json() as { configured?: boolean; setupMessage?: string; channels?: YouTubeChannel[]; uploads?: YouTubeUpload[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not read connected YouTube channels.");
      setConfigured(data.configured !== false);
      if (data.configured === false) setError(data.setupMessage || "YouTube OAuth is not configured on this cloud service.");
      setChannels(data.channels || []);
      setUploads((data.uploads || []).filter((upload) => upload.jobId === jobId));
      if (data.configured !== false) setError(null);
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
      if (event.origin !== (processorUrl ? new URL(processorUrl).origin : window.location.origin) || event.data?.type !== "touchline-youtube-connected") return;
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
      await fetch(`${processorUrl}/jobs/${jobId}/published`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: data.url, videoId: data.videoId, channelId: data.channelId }),
      }).catch(() => {});
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
async function uploadFileInChunks(jobId: string, uploadUrl: string, file: File, setUploadPercent: (value: number) => void) {
  const contentType = file.type || "video/mp4";
  const probe = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Range": `bytes */${file.size}`, "Content-Type": contentType } });
  if ([404, 410].includes(probe.status)) throw new Error("UPLOAD_SESSION_EXPIRED");
  if (![200, 201, 308].includes(probe.status)) throw new Error(`Cloud Storage could not read the saved upload offset (${probe.status}).`);
  let offset = probe.status === 200 || probe.status === 201 ? file.size : uploadedOffset(probe.headers.get("Range"));
  const chunkSize = 8 * 1024 * 1024;
  while (offset < file.size) {
    const endExclusive = Math.min(file.size, offset + chunkSize);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: file.slice(offset, endExclusive),
      headers: { "Content-Type": contentType, "Content-Range": `bytes ${offset}-${endExclusive - 1}/${file.size}` },
    });
    if ([404, 410].includes(response.status)) throw new Error("UPLOAD_SESSION_EXPIRED");
    if (![200, 201, 308].includes(response.status)) throw new Error(`Cloud Storage rejected an upload chunk (${response.status}).`);
    offset = response.status === 200 || response.status === 201 ? file.size : Math.max(endExclusive, uploadedOffset(response.headers.get("Range")));
    const percent = Math.min(100, Math.round(offset / file.size * 100));
    setUploadPercent(percent);
    const progressResponse = await fetch(`${processorUrl}/jobs/${jobId}/upload-progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedBytes: offset }),
    });
    if (!progressResponse.ok && progressResponse.status !== 409) throw new Error("The cloud could not save upload progress.");
  }
}
function uploadedOffset(range: string | null) { const match = String(range || "").match(/bytes=0-(\d+)/i); return match ? Number(match[1]) + 1 : 0; }
function formatBytes(bytes: number) { if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"; if (bytes < 1024) return `${Math.round(bytes)} B`; if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`; if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatTime(seconds: number) { const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0; return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`; }
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatSubscribers(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0); }
function formatJobDate(value?: string) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Saved in cloud"; }
function jobDisplayProgress(job: LocalJob) { return job.stage === "uploading" && job.sourceSize ? Math.round(Number(job.uploadedBytes || 0) / job.sourceSize * 100) : Number(job.progress || 0); }
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
function cloudStageLabel(stage: CloudJobStage) { const labels:Record<string,string>={importing:'Downloading authorized source',uploading:'Uploading from this device',uploaded:'Source secured',queued:'Waiting for a cloud worker',downloading:'Downloading the saved cloud source',restoring:'Restoring saved processing'};return labels[stage]||'Building your edit'; }

async function uploadVideoDuration(file:File):Promise<number> {
  const video=document.createElement('video'),url=URL.createObjectURL(file);
  try {return await new Promise<number>((resolve,reject)=>{
    const timer=window.setTimeout(()=>reject(new Error('Could not read the video duration. Check the source file.')),15000);
    video.preload='metadata';
    video.onloadedmetadata=()=>{window.clearTimeout(timer);resolve(video.duration);};
    video.onerror=()=>{window.clearTimeout(timer);reject(new Error('Could not read the video duration. Check the source file.'));};
    video.src=url;
  });}finally{video.onloadedmetadata=null;video.onerror=null;video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
function toBase64Url(value: string) { const bytes = new TextEncoder().encode(value); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); return window.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
