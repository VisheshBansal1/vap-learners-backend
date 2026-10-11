#!/usr/bin/env python3
"""
python_pipeline/run_generation.py
──────────────────────────────────
Spawned by Node.js videoWorker.js as a child process.

Env vars set by Node before spawning:
  VIDEO_ID, USER_ID, TOPIC, DIFFICULTY, VOICE,
  GROQ_API_KEY, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET, FIREBASE_CRED_JSON

Prints ONE JSON object per line to stdout → Node reads and fans out to SSE.

Folder layout:
  project_root/
    backend/
      python_pipeline/run_generation.py   ← this file
    vavina_learner_video_generator/        ← existing Python pipeline
"""

import json
import os
import sys
import time
from pathlib import Path

# ── Add pipeline to path ─────────────────────────────────────────────────────
_THIS     = Path(__file__).parent.resolve()
_ROOT     = _THIS.parent.parent
_PIPELINE = _ROOT / "vavina_learner_video_generator"
sys.path.insert(0, str(_PIPELINE))

# ── Job params from env ───────────────────────────────────────────────────────
VIDEO_ID   = os.environ["VIDEO_ID"]
USER_ID    = os.environ["USER_ID"]
TOPIC      = os.environ["TOPIC"]
DIFFICULTY = os.environ.get("DIFFICULTY", "intermediate")
VOICE      = os.environ.get("VOICE", "english")


def push(progress: int, message: str, status: str = "processing", **extra):
    """Print one JSON progress event — Node.js reads from stdout."""
    event = {
        "status":   status,
        "progress": progress,
        "message":  message,
        "ts":       time.time(),
        **extra,
    }
    print(json.dumps(event), flush=True)


def setup_cloudinary():
    """Configure cloudinary SDK from env vars."""
    import cloudinary
    cloudinary.config(
        cloud_name  = os.environ["CLOUDINARY_CLOUD_NAME"],
        api_key     = os.environ["CLOUDINARY_API_KEY"],
        api_secret  = os.environ["CLOUDINARY_API_SECRET"],
        secure      = True,
    )


def upload_video(output_path: Path) -> str:
    """Upload MP4 to Cloudinary, return secure streaming URL."""
    import cloudinary.uploader
    public_id = f"vavina/videos/{USER_ID}_{VIDEO_ID}"
    result = cloudinary.uploader.upload(
        str(output_path),
        resource_type     = "video",
        public_id         = public_id,
        overwrite         = True,
        upload_preset     = "vavina_videos",
        # Streaming profile for HLS adaptive delivery
        eager             = [{"streaming_profile": "full_hd", "format": "m3u8"}],
        eager_async       = True,
        # Auto quality + format optimization
        quality            = "auto",
        # Tags for easy management
        tags              = [USER_ID, "tutorial", "ai_generated"],
    )
    # Return the secure MP4 URL
    return result["secure_url"]


def upload_thumbnail(thumb_path: Path) -> str:
    """Upload thumbnail JPG to Cloudinary, return optimized image URL."""
    import cloudinary.uploader
    public_id = f"vavina/thumbnails/{USER_ID}_{VIDEO_ID}"
    result = cloudinary.uploader.upload(
        str(thumb_path),
        resource_type  = "image",
        public_id      = public_id,
        overwrite      = True,
        upload_preset  = "vavina_thumbnails",
        # Auto quality + WebP delivery
        quality        = "auto",
        fetch_format   = "auto",
        # Resize thumbnail to standard size
        transformation = [{"width": 1280, "height": 720, "crop": "fill", "gravity": "auto"}],
        tags           = [USER_ID, "thumbnail", "ai_generated"],
    )
    return result["secure_url"]


def update_firestore(video_url: str, thumb_url: str, duration: int, file_size: int):
    """Update Firestore directly from Python as a safety net backup."""
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        if not firebase_admin._apps:
            cred_json = os.environ.get("FIREBASE_CRED_JSON")
            if cred_json:
                import json as _json
                cred = credentials.Certificate(_json.loads(cred_json))
                firebase_admin.initialize_app(cred)

        db = firestore.client()
        db.collection("users").document(USER_ID) \
          .collection("videos").document(VIDEO_ID) \
          .update({
              "status":       "completed",
              "videoUrl":     video_url,
              "thumbnailUrl": thumb_url,
              "duration":     duration,
              "fileSize":     file_size,
          })
    except Exception as e:
        # Node.js also updates Firestore — this is just a backup
        print(f"[Python Firestore backup update failed: {e}]", file=sys.stderr)


def run():
    try:
        # ── Cloudinary config ─────────────────────────────────────────────────
        setup_cloudinary()
        push(3, "Detecting programming language…")

        # ── Language detection ────────────────────────────────────────────────
        from utils.language_detector import detect_language, language_display_name
        lang      = detect_language(TOPIC)
        lang_name = language_display_name(lang)
        push(6, f"Language: {lang_name}")

        # ── Script generation ─────────────────────────────────────────────────
        push(8, f"Generating {lang_name} script via Groq AI…")
        from script.groq_script import GroqScriptGenerator
        script = GroqScriptGenerator().generate(TOPIC, difficulty=DIFFICULTY, language=lang)
        push(22, f"Script ready — {len(script['sections'])} sections")

        # ── Code execution ────────────────────────────────────────────────────
        push(25, "Executing code examples…")
        NON_EXEC = {
            "sql", "html_css", "swift", "kotlin", "csharp", "rust", "go",
            "cpp", "c", "java", "dart", "javascript", "typescript", "ruby", "php", "bash",
        }
        from engine.code_runner import CodeRunner
        runner = CodeRunner(timeout=25)
        setup  = next(
            (s.get("code", "") for s in script["sections"] if s.get("type") == "code"), ""
        )
        for sec in script["sections"]:
            if sec["type"] not in ("code", "execution"):
                sec["output"] = {"stdout": "", "success": False}
                continue
            code = sec.get("code", "")
            if not code.strip():
                sec["output"] = {"stdout": "", "success": False}
                continue
            if lang in NON_EXEC:
                sec["output"] = {"stdout": f"# {lang_name} output", "success": True}
            elif sec["type"] == "execution" and setup:
                sec["output"] = runner.execute_with_context(setup, code)
            else:
                sec["output"] = runner.execute(code)
        push(35, "Code execution done")

        # ── TTS ───────────────────────────────────────────────────────────────
        voice_label = "hi-IN-SwaraNeural" if VOICE == "hindi" else "en-US-AriaNeural"
        push(37, f"Synthesising narration ({voice_label})…")
        from tts.tts_engine import TTSEngine
        audio_map = TTSEngine(voice_language=VOICE).generate_all(
            script["sections"], topic=TOPIC
        )
        push(52, f"Narration ready — {len(audio_map)} segments")

        # ── Render frames ─────────────────────────────────────────────────────
        push(54, "Rendering animated frames…")
        from engine.animator import Animator
        animator = Animator(fps=24)
        frame_seqs, timeline = animator.generate_all(script, audio_map)
        frame_seqs = animator.add_fade_transitions(frame_seqs, fade_frames=10)

        def _expand_timeline(orig_tl, seqs):
            fps, expanded, tl_it = 24, [], iter(orig_tl)
            for seq in seqs:
                n, dur = len(seq), round(len(seq) / 24, 4)
                is_fade = seq and "fade_" in str(seq[0])
                if is_fade:
                    expanded.append({
                        "section_index": -99, "section_type": "fade",
                        "duration": dur, "frame_count": n,
                        "audio_path": None, "audio_duration": None, "fps": fps,
                    })
                else:
                    try:
                        tl = next(tl_it).copy()
                    except StopIteration:
                        tl = {
                            "section_index": -1, "section_type": "unknown",
                            "audio_path": None, "audio_duration": None, "fps": fps,
                        }
                    tl["frame_count"] = n
                    tl["duration"]    = dur
                    expanded.append(tl)
            return expanded

        exp_tl = _expand_timeline(timeline, frame_seqs)
        push(70, "Frames rendered")

        # ── Build MP4 ─────────────────────────────────────────────────────────
        push(72, "Building MP4 with ffmpeg…")
        from video.video_builder import VideoBuilder
        output_path = Path(VideoBuilder(fps=24, crf=18, preset="medium").build(
            frame_sequences=frame_seqs,
            timeline=exp_tl,
            title=script["title"],
        ))
        total_dur = int(sum(e["duration"] for e in timeline))
        file_size = output_path.stat().st_size
        push(82, f"MP4 built ({round(file_size / 1024 / 1024, 1)} MB)")

        # ── Thumbnail from first frame ─────────────────────────────────────────
        push(83, "Extracting thumbnail…")
        import cv2
        import numpy as np
        thumb_path = output_path.with_suffix(".jpg")
        cap = cv2.VideoCapture(str(output_path))
        ret, frame = cap.read()
        cap.release()
        if ret:
            cv2.imwrite(str(thumb_path), frame)
        else:
            cv2.imwrite(str(thumb_path), np.zeros((720, 1280, 3), dtype=np.uint8))
        push(84, "Thumbnail extracted")

        # ── Upload video to Cloudinary ────────────────────────────────────────
        push(85, "Uploading video to Cloudinary…")
        video_url = upload_video(output_path)
        push(93, "Video uploaded ✓")

        # ── Upload thumbnail to Cloudinary ────────────────────────────────────
        push(94, "Uploading thumbnail to Cloudinary…")
        thumb_url = upload_thumbnail(thumb_path)
        push(97, "Thumbnail uploaded ✓")

        # ── Cleanup temp files ────────────────────────────────────────────────
        for p in [output_path, thumb_path]:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass

        # ── Update Firestore (backup — Node also does this) ───────────────────
        update_firestore(video_url, thumb_url, total_dur, file_size)

        # ── Done ─────────────────────────────────────────────────────────────
        push(
            100,
            "🎬 Video ready!",
            status       = "completed",
            videoUrl     = video_url,
            thumbnailUrl = thumb_url,
            duration     = total_dur,
            fileSize     = file_size,
            topic        = TOPIC,
        )

    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        push(0, f"Error: {exc}", status="failed", error=str(exc))
        sys.exit(1)


if __name__ == "__main__":
    run()
