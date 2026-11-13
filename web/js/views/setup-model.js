// Setups made from other setups or from a bench run, without any DOM.
import { copy } from '../util.js';


const withIds = (questions, uuid) =>
  questions.map((q) => {
    const out = { ...q };
    if (q.options) out.options = q.options.map((o) => ({ ...o, id: uuid() }));
    if (q.levels) out.levels = q.levels.map((l) => ({ ...l, id: uuid() }));
    return out;
  });

export function duplicate(setup, uuid = () => crypto.randomUUID()) {
  return {
    id: uuid(),
    name: `${[...setup.name].slice(0, 55).join('')} copy`,
    sampleState: setup.sampleState ?? '',
    questions: withIds(copy(setup.questions), uuid),
  };
}

export function fromRun(run, name, uuid = () => crypto.randomUUID()) {
  return { id: uuid(), name, sampleState: run.state, questions: copy(run.questions) };
}
