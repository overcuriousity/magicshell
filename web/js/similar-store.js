import {
  embeddingBatches,
  embeddingText,
  normalize,
  questionSources,
  rankOptions,
  rankScales,
} from './similar.js';

const questionKey = (text) => (typeof text === 'string' ? text.trim().toLowerCase() : '');

export function createSimilarService({
  client,
  config,
  sources: readSources,
  vectors,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const memory = new Map();
  let data = { history: [], setups: [] };
  let sources = [];
  let sourceMap = new Map();
  let active = null;
  let generation = 0;
  let initializing = null;
  let updated = false;
  let queue = Promise.resolve();
  let work = null;
  let retryTimer = null;
  let retryAt = 0;
  let retryUsed = false;

  const recordKey = (key) => `${config.id}\0${key}`;

  function notify(atGeneration) {
    if (atGeneration !== generation || !active) return;
    try {
      active.onChange();
    } catch {
      // Suggestions must not interrupt the remaining embedding work.
    }
  }

  function removeRecords(keys) {
    if (keys.length > 0) vectors.remove(keys).catch(() => {});
  }

  function replaceSources(next) {
    data = next ?? { history: [], setups: [] };
    sources = questionSources(data);
    if (active && !sources.some((source) => source.key === active.key)) {
      sources.unshift({ key: active.key, text: active.text, last: '', options: [], scales: [] });
    }
    sourceMap = new Map(sources.map((source) => [source.key, source]));
    const stale = [];
    for (const key of memory.keys()) {
      if (!sourceMap.has(key)) {
        memory.delete(key);
        stale.push(recordKey(key));
      }
    }
    removeRecords(stale);
  }

  async function initialize() {
    await vectors.claim(config.owner);
    const records = await vectors.all();
    const fetched = updated ? null : await readSources();
    replaceSources(updated ? data : fetched);
    memory.clear();
    const stale = [];
    for (const record of records) {
      const key = record?.questionKey;
      if (record?.configId !== config.id || typeof key !== 'string' || !sourceMap.has(key)
        || record.key !== recordKey(key)) {
        if (typeof record?.key === 'string') stale.push(record.key);
        continue;
      }
      if (record.refused) {
        memory.set(key, null);
        continue;
      }
      const vector = normalize(record.vector);
      if (vector) memory.set(key, vector);
      else stale.push(record.key);
    }
    if (stale.length > 0) await vectors.remove(stale);
  }

  function enqueue(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  function scheduleRetry(atGeneration) {
    if (atGeneration !== generation || retryUsed || !active) return;
    retryUsed = true;
    retryAt = now() + 30000;
    const attempt = () => {
      retryTimer = null;
      if (atGeneration !== generation || !active) return;
      const remaining = retryAt - now();
      if (remaining > 0) {
        retryTimer = setTimeoutFn(attempt, remaining);
        return;
      }
      startWork(true);
    };
    retryTimer = setTimeoutFn(attempt, 30000);
  }

  function cancelRetry() {
    if (retryTimer !== null) clearTimeoutFn(retryTimer);
    retryTimer = null;
    retryAt = 0;
  }

  function validSource(key, atGeneration) {
    return atGeneration === generation && sourceMap.get(key);
  }

  async function persist(source, vector, refused, atGeneration) {
    if (!validSource(source.key, atGeneration)) return false;
    const record = {
      key: recordKey(source.key),
      configId: config.id,
      questionKey: source.key,
      text: source.text,
      vector,
      refused,
    };
    await vectors.put(record);
    if (!validSource(source.key, atGeneration)) {
      await vectors.remove([record.key]);
      return false;
    }
    memory.set(source.key, vector);
    if (active?.key === source.key) active.query = vector;
    return true;
  }

  async function saveRefusal(source, atGeneration) {
    if (await persist(source, null, true, atGeneration)) notify(atGeneration);
  }

  async function saveVectors(batch, reply, atGeneration) {
    let changed = false;
    for (let i = 0; i < batch.length; i += 1) {
      const source = batch[i];
      const vector = normalize(reply[i]);
      if (await persist(source, vector, vector === null, atGeneration)) changed = true;
      if (atGeneration !== generation) return;
    }
    if (changed) notify(atGeneration);
  }

  async function fetchBatch(batch, atGeneration, state) {
    try {
      const reply = await client.embed(batch.map((source) => embeddingText(source.text)));
      await saveVectors(batch, reply, atGeneration);
    } catch (error) {
      if (error.kind !== 'validation') {
        state.failed = true;
        scheduleRetry(atGeneration);
        return;
      }
      if (batch.length > 1) {
        for (const source of batch) {
          if (atGeneration !== generation) return;
          await fetchBatch([source], atGeneration, state);
        }
      } else {
        await saveRefusal(batch[0], atGeneration);
      }
    }
  }

  async function runBatches(atGeneration, retrying) {
    const state = { failed: false };
    while (atGeneration === generation && active) {
      const missing = sources.filter((source) => !memory.has(source.key) && embeddingText(source.text));
      missing.sort((a, b) => {
        if (a.key === active.key) return -1;
        if (b.key === active.key) return 1;
        return b.last.localeCompare(a.last);
      });
      if (missing.length === 0) return;
      for (const batch of embeddingBatches(missing)) {
        if (atGeneration !== generation) return;
        await fetchBatch(batch, atGeneration, state);
      }
      if (retryTimer !== null || (retrying && state.failed)) return;
    }
  }

  function startWork(retrying = false) {
    if (!active) return Promise.resolve();
    if (!retrying && retryTimer !== null && now() < retryAt) return Promise.resolve();
    if (work?.generation === generation) return work.promise;
    const atGeneration = generation;
    const promise = enqueue(async () => {
      try {
        if (!initializing) {
          initializing = initialize().catch((error) => {
            initializing = null;
            throw error;
          });
        }
        await initializing;
        if (atGeneration !== generation || !active) return;
        if (memory.has(active.key)) active.query = memory.get(active.key);
        await runBatches(atGeneration, retrying);
      } catch {
        // Loading suggestions is best effort; the guide never waits for it.
      }
    });
    work = { generation: atGeneration, promise };
    promise.then(() => {
      if (work?.promise === promise) work = null;
    });
    return promise;
  }

  function load(question, onChange = () => {}) {
    const text = typeof question === 'string' ? question : '';
    const key = questionKey(text);
    if (active?.key === key && active.text === text) {
      active.onChange = onChange;
      return startWork().catch(() => {});
    }
    cancelRetry();
    generation += 1;
    retryUsed = false;
    active = key ? { key, text, query: null, onChange } : null;
    replaceSources(data);
    if (active && memory.has(key)) active.query = memory.get(key);
    return startWork().catch(() => {});
  }

  function offers(question) {
    if (!active || active.key !== questionKey(question) || !active.query) return null;
    return { sources, vectors: memory, query: active.query, min: config.min };
  }

  function offerSnapshot() {
    const current = offers(active?.text);
    if (!current) return '';
    return JSON.stringify([
      rankOptions(current.sources, current.vectors, current.query, { min: current.min }),
      rankScales(current.sources, current.vectors, current.query, { min: current.min }),
    ]);
  }

  function update(next) {
    const before = offerSnapshot();
    updated = true;
    replaceSources(next);
    if (offerSnapshot() !== before) notify(generation);
    if (active) startWork();
  }

  async function clear() {
    cancelRetry();
    generation += 1;
    retryUsed = false;
    active = null;
    initializing = null;
    memory.clear();
    replaceSources(data);
    await vectors.clear();
  }

  return {
    load,
    update,
    clear,
    options(question, exclude = []) {
      const current = offers(question);
      return current ? rankOptions(current.sources, current.vectors, current.query, {
        min: current.min, exclude,
      }) : [];
    },
    scales(question, currentScale = []) {
      const current = offers(question);
      return current ? rankScales(current.sources, current.vectors, current.query, {
        min: current.min, current: currentScale,
      }) : [];
    },
  };
}
