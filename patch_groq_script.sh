# #!/bin/bash
# # Run this ONCE from the backend/ folder to fix groq_script.py model name
# # Usage: bash patch_groq_script.sh

# PIPELINE_PATH="../vavina_learner_video_generator/script/groq_script.py"

# if [ ! -f "$PIPELINE_PATH" ]; then
#   echo "ERROR: $PIPELINE_PATH not found. Run from the backend/ folder."
#   exit 1
# fi

# # Use | as sed delimiter to avoid conflict with / in model name
# sed -i 's|llama-3.3-70b-versatile|openai/gpt-oss-20b|g' "$PIPELINE_PATH"
# sed -i 's|llama3-70b-8192|openai/gpt-oss-20b|g' "$PIPELINE_PATH"

# echo "✓ Fixed model name in $PIPELINE_PATH"
# grep "GROQ_MODEL" "$PIPELINE_PATH"
