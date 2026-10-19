# Optional image only. No Compose/Render service is created or enabled here.
ARG ZIIPA_API_IMAGE=ziipa-api:local
FROM debian:bookworm-slim AS speech-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git cmake build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# v1.9.5 and binary release b5454 resolve to this same official upstream commit.
RUN git init whisper && cd whisper && \
    git remote add origin https://github.com/ggml-org/whisper.cpp.git && \
    git fetch --depth 1 origin d1be6fde11ac6e0407606b4e42fe72d34add8037 && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = d1be6fde11ac6e0407606b4e42fe72d34add8037 && \
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_BLAS=OFF -DGGML_CUDA=OFF \
      -DGGML_VULKAN=OFF -DGGML_BACKEND_DL=OFF -DWHISPER_FFMPEG=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON && \
    cmake --build build --config Release --target whisper-cli --parallel 2

FROM ${ZIIPA_API_IMAGE}
USER root
COPY --from=speech-build /src/whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY deploy/transcription/entrypoint.sh /usr/local/bin/ziipa-speech-entrypoint
RUN chmod 0555 /usr/local/bin/whisper-cli /usr/local/bin/ziipa-speech-entrypoint
ENV TRANSCRIPTION_ENABLED=false \
    TRANSCRIPTION_EXECUTABLE=/usr/local/bin/whisper-cli \
    TRANSCRIPTION_MODEL=/models/ggml-tiny.en.bin \
    TRANSCRIPTION_FFMPEG=/usr/bin/ffmpeg \
    TRANSCRIPTION_FFPROBE=/usr/bin/ffprobe \
    TRANSCRIPTION_WORK_DIR=/speech-work \
    TRANSCRIPTION_TIMEOUT_SECONDS=75
USER ziipa
ENTRYPOINT ["/usr/local/bin/ziipa-speech-entrypoint"]
CMD ["sh", "-c", "python render_migrate.py && exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
