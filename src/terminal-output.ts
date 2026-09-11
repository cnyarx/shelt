export const MAX_TERMINAL_OUTPUT_QUEUE_BYTES = 1024 * 1024;

type TerminalWriter = (data: string | Uint8Array, callback: () => void) => void;

export class TerminalOutputPump {
  private readonly queue: Array<{ data: string | Uint8Array; bytes: number }> = [];
  private pendingBytes = 0;
  private writing = false;
  private closed = false;

  constructor(
    private readonly write: TerminalWriter,
    private readonly acknowledge: (bytes: number) => void,
    private readonly overflow: () => void,
    private readonly maxQueueBytes = MAX_TERMINAL_OUTPUT_QUEUE_BYTES,
  ) {}

  enqueue(data: string | Uint8Array): void {
    if (this.closed) return;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (this.pendingBytes + bytes > this.maxQueueBytes) {
      this.closed = true;
      this.queue.length = 0;
      this.pendingBytes = 0;
      this.overflow();
      return;
    }
    this.queue.push({ data, bytes });
    this.pendingBytes += bytes;
    this.flush();
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.pendingBytes = 0;
  }

  private flush(): void {
    if (this.closed || this.writing) return;
    const next = this.queue.shift();
    if (!next) return;
    this.writing = true;
    this.write(next.data, () => {
      this.writing = false;
      if (this.closed) return;
      this.pendingBytes -= next.bytes;
      this.acknowledge(next.bytes);
      this.flush();
    });
  }
}
