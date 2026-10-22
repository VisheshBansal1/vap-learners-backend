#!/bin/bash
# Run this once on Render shell or locally to fix groq_script.py model name
# Usage: bash patch_groq_script.sh

PIPELINE_PATH="../vavina_learner_video_generator/script/groq_script.py"

if [ ! -f "$PIPELINE_PATH" ]; then
  echo "ERROR: $PIPELINE_PATH not found. Run from the backend/ folder."
  exit 1
fi

sed -i 's/llama-3.3-70b-versatile/llama3-70b-8192/g' "$PIPELINE_PATH"
echo "✓ Fixed model name in $PIPELINE_PATH"
grep "GROQ_MODEL" "$PIPELINE_PATH"
