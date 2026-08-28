# video-engine — Render Web Service image.
#
# The tricky part of this build (and the one thing you should sanity-check with a real
# `docker build` before trusting a Render deploy to it) is the ffmpeg stage: this app
# needs ffmpeg's built-in `whisper` filter for real audio transcription/alignment
# (src/transcribe.js), which is NOT part of any standard ffmpeg package (apt, BtbN's
# static builds, etc.) — it only exists if ffmpeg was compiled with --enable-whisper
# against a statically-linked whisper.cpp. That's what the "whisper" and "ffmpeg" stages
# below do from source. Everything else this app touches from ffmpeg is ordinary
# (libx264 video encode, ffmpeg's native AAC encoder, native PNG/MP3 decode — see
# src/assemble.js) so no other codec libraries are needed.
#
# Expect the first build to take a while (compiling whisper.cpp + ffmpeg from source).
# Docker layer caching makes subsequent builds fast as long as these stages don't change.

# ---- Stage 1: whisper.cpp, built as static libraries ----
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git .
# Default (no BUILD_SHARED_LIBS) produces static .a libs — exactly what we want to
# link straight into the ffmpeg binary, so the runtime image needs no whisper .so at all.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)"
RUN mkdir -p /opt/whisper/lib /opt/whisper/include \
    && find build -name '*.a' -exec cp {} /opt/whisper/lib/ \; \
    && cp include/whisper.h /opt/whisper/include/ \
    && find . -path ./build -prune -o -name 'ggml*.h' -print -exec cp {} /opt/whisper/include/ \;

# ---- Stage 2: ffmpeg, built from source with --enable-whisper ----
FROM debian:bookworm-slim AS ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config yasm nasm libx264-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /opt/whisper /opt/whisper
WORKDIR /src
RUN git clone --depth 1 https://git.ffmpeg.org/ffmpeg.git .
# The exact set of whisper.cpp/ggml static libs produced varies by version, so this
# discovers whatever got built in stage 1 rather than hardcoding filenames — --start-group
# / --end-group lets the linker resolve their cross-references regardless of order.
RUN WHISPER_LIBS="$(ls /opt/whisper/lib/*.a | tr '\n' ' ')" && \
    ./configure \
      --prefix=/opt/ffmpeg \
      --enable-gpl \
      --enable-libx264 \
      --enable-whisper \
      --extra-cflags="-I/opt/whisper/include" \
      --extra-ldflags="-L/opt/whisper/lib" \
      --extra-libs="-Wl,--start-group ${WHISPER_LIBS} -Wl,--end-group -lstdc++ -lm -lpthread" \
    && make -j"$(nproc)" && make install

# ---- Stage 3: runtime ----
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libx264-dev ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe
RUN ffmpeg -version | grep -q whisper 2>/dev/null || echo "warning: 'whisper' not found in ffmpeg -buildconf output — check the ffmpeg build stage"

WORKDIR /app
COPY . .
# Fetched at build time rather than committed to git — it's 142MB, over GitHub's 100MB
# per-file limit, so keeping it out of the repo avoids needing Git LFS.
RUN mkdir -p models && \
    curl -fL -o models/ggml-base.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

ENV NODE_ENV=production
# Render sets $PORT at runtime; server.js reads it directly.
EXPOSE 3939
CMD ["node", "server.js"]
