# Vavina Learners backend — Node API + Python/ffmpeg video pipeline.
# Render's normal Node runtime can't `apt-get install ffmpeg`; Docker can, so video generation works.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ffmpeg espeak-ng fonts-dejavu-core \
      libgl1 libglib2.0-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python packages live in a virtualenv (system pip refuses installs on Debian 12)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHON_BIN=/opt/venv/bin/python \
    NODE_ENV=production
RUN pip install --no-cache-dir cloudinary firebase-admin edge-tts \
      opencv-python-headless numpy pillow python-dotenv requests

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Extra Python packages your video pipeline needs (if the folder has a requirements file)
RUN if [ -f vavina_learner_video_generator/requirements.txt ]; then \
      pip install --no-cache-dir -r vavina_learner_video_generator/requirements.txt; fi

# Render injects PORT; index.js already reads it.
EXPOSE 3000
CMD ["node", "index.js"]
