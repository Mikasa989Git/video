# video-engine — Render Web Service image.
#
# The tricky part of this build (and the one thing you should sanity-check with a real
# `docker build` before trusting a Render deploy to it) is the ffmpeg stage: this app
# needs ffmpeg's built-in `whisper` filter for real audio transcription/alignment
# (src/transcribe.js), which is NOT part of any standard ffmpeg package (apt, BtbN's
# static builds, etc.) — it only exists if ffmpeg was compiled with --enable-whisper
# against whisper.cpp. That's what the "whisper" and "ffmpeg" stages below do from
# source. Everything else this app touches from ffmpeg is ordinary (libx264 video
# encode, ffmpeg's native AAC encoder, native PNG/MP3 decode — see src/assemble.js)
# so no other codec libraries are needed.
#
# Expect the first build to take a while (compiling whisper.cpp + ffmpeg from source).
# Docker layer caching makes subsequent builds fast as long as these stages don't change.

# ---- Stage 1: whisper.cpp ----
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git .
# whisper.cpp's CMake build produces shared libs (libwhisper.so, libggml*.so) by
# default — going with that rather than fighting it into a static build, since
# forcing BUILD_SHARED_LIBS=OFF here turned out to just relocate the same problem.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)"
RUN mkdir -p /opt/whisper/lib /opt/whisper/include \
    && find build -name '*.so*' -exec cp -P {} /opt/whisper/lib/ \; \
    && cp include/whisper.h /opt/whisper/include/ \
    && find . -path ./build -prune -o -name 'ggml*.h' -print -exec cp {} /opt/whisper/include/ \;
# ffmpeg's --enable-whisper detects the library via pkg-config (not raw
# cflags/ldflags), so it needs a .pc file describing it — whisper.cpp's own build
# doesn't generate one.
RUN mkdir -p /opt/whisper/lib/pkgconfig && \
    printf 'prefix=/opt/whisper\nexec_prefix=${prefix}\nlibdir=${exec_prefix}/lib\nincludedir=${prefix}/include\n\nName: whisper\nDescription: whisper.cpp\nVersion: 1.7.6\nLibs: -L${libdir} -lwhisper -lggml-cpu -lggml-base -lggml\nCflags: -I${includedir}\n' \
      > /opt/whisper/lib/pkgconfig/whisper.pc

# ---- Stage 2: ffmpeg, built from source with --enable-whisper ----
FROM debian:bookworm-slim AS ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config yasm nasm libx264-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /opt/whisper /opt/whisper
ENV PKG_CONFIG_PATH=/opt/whisper/lib/pkgconfig
# configure's own sanity checks compile-and-run small test programs against the
# whisper lib, so the shared libs need to be loadable during the build, not just at
# final runtime.
ENV LD_LIBRARY_PATH=/opt/whisper/lib
WORKDIR /src
RUN git clone --depth 1 https://git.ffmpeg.org/ffmpeg.git .
RUN ./configure \
      --prefix=/opt/ffmpeg \
      --enable-gpl \
      --enable-libx264 \
      --enable-whisper \
    && make -j"$(nproc)" && make install

# ---- Stage 3: runtime ----
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libx264-dev ca-certificates curl libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=whisper /opt/whisper/lib/ /usr/local/lib/
RUN ldconfig
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
