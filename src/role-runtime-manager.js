import crypto from 'node:crypto';

export class RoleRuntimeManager {
  constructor({ category, createRuntime, emptySnapshot, autoStart = false }) {
    this.category = category; this.createRuntime = createRuntime; this.emptySnapshot = emptySnapshot;
    this.entries = new Map(); this.roles = {}; this.queue = Promise.resolve(); this.autoStart = autoStart;
  }
  reconcile(records, assignments = {}) {
    const operation = this.queue.then(async () => {
      this.roles = { ...assignments };
      const wanted = new Map(records.map((record) => [record.id, record]));
      for (const [id, entry] of this.entries) {
        const record = wanted.get(id);
        if (!record || this.signature(record) !== entry.signature) { await entry.runtime.stop?.(); this.entries.delete(id); }
      }
      for (const record of records) if (!this.entries.has(record.id)) {
        const signature = this.signature(record); const runtime = await this.createRuntime(record, signature);
        try {
          if (this.autoStart) await runtime.start?.();
          this.entries.set(record.id, { signature, runtime });
        } catch (startError) {
          await runtime.stop?.();
          throw startError;
        }
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  signature(record) {
    const physical = this.category === 'sensor' ? [record.model, record.tuyaDeviceId] : [record.model, record.ip, record.mac];
    return crypto.createHash('sha256').update(JSON.stringify(physical)).digest('hex').slice(0, 16);
  }
  runtimeForRole(role) { const id = Object.keys(this.roles).find((candidate) => this.roles[candidate] === role); return id ? this.entries.get(id)?.runtime || null : null; }
  recordIdForRole(role) { return Object.keys(this.roles).find((id) => this.roles[id] === role) || null; }
  async snapshot(role) { await this.queue; return (await this.runtimeForRole(role)?.snapshot?.()) || this.emptySnapshot(); }
  async history(role, date) { await this.queue; return (await this.runtimeForRole(role)?.history?.(date)) || { date: date ?? null, samples: [] }; }
  async imagePath(role) { await this.queue; return (await this.runtimeForRole(role)?.imagePath?.()) || null; }
  async start(role) { await this.queue; const runtime = this.runtimeForRole(role); if (!runtime) { const error = new Error(`${this.category} non configurata.`); error.code = 'DEVICE_NOT_CONFIGURED'; throw error; } return runtime.start(); }
  async stop(role) { await this.queue; return (await this.runtimeForRole(role)?.stop?.()) || this.emptySnapshot(); }
  has(id) { return this.entries.has(id); }
  async close() { await this.queue; await Promise.all([...this.entries.values()].map(({ runtime }) => runtime.stop?.())); this.entries.clear(); }
}
