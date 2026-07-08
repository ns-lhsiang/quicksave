/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly QUICKSAVE_SIGNALING_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
