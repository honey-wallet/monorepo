// Response shapes returned by the Rust server (apps/server/src/routes).
// Keep these in sync when changing a handler's response type.

export interface Health {
  status: 'ok';
}

export interface VersionInfo {
  name: string;
  version: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
