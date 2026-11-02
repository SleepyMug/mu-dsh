// Where the gateway's log lines go (journald, via stdout/stderr, in production).

export interface Logger {
  info(message: string): void
  error(message: string): void
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
}
