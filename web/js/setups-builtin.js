// Built-in setups and ready scales, deeply frozen. Option and level ids are stable.
const freeze = (v) => {
  if (v !== null && typeof v === 'object') Object.values(v).forEach(freeze);
  return Object.freeze(v);
};

const levels = (...texts) => texts.map((text, i) => ({ id: `l${i + 1}`, text }));
const options = (...pairs) => pairs.map(([name, description], i) => ({ id: `o${i + 1}`, name, description }));
const numbers = (n) => Array.from({ length: n }, (_, i) => String(i + 1));

export const SCALES = freeze([
  { id: '1-5', name: '1 to 5', levels: numbers(5) },
  { id: '1-10', name: '1 to 10', levels: numbers(10) },
  { id: 'degree', name: 'Not at all to very', levels: ['not at all', 'a little', 'somewhat', 'very'] },
  { id: 'urgency', name: 'Urgency', levels: ['can wait', 'this week', 'today', 'right now'] },
]);

const scale = (id) => SCALES.find((s) => s.id === id).levels;

export const BUILTIN = freeze([
  {
    id: 'builtin-yes-no',
    builtin: true,
    name: 'Yes or no',
    sampleState: '',
    questions: [{ key: 'q1', type: 'noul', text: '' }],
  },
  {
    id: 'builtin-triage',
    builtin: true,
    name: 'Ticket triage',
    sampleState: 'I was charged twice for my order and the app shows an error when I open the invoice.',
    questions: [
      {
        key: 'team',
        type: 'choice',
        text: 'Which team should handle this?',
        options: options(
          ['billing', 'payments, charges, refunds, invoices'],
          ['tech', 'errors, outages, how-to'],
          ['sales', 'contracts, upgrades, pricing'],
        ),
      },
      { key: 'urgency', type: 'score', text: 'How urgent is this?', levels: levels(...scale('urgency')) },
      { key: 'angry', type: 'noul', text: 'Is the customer angry?' },
    ],
  },
  {
    id: 'builtin-sentiment',
    builtin: true,
    name: 'Sentiment',
    sampleState: '',
    questions: [
      {
        key: 'q1',
        type: 'choice',
        text: 'What is the mood of this text?',
        options: options(['positive', ''], ['neutral', ''], ['negative', '']),
      },
    ],
  },
  {
    id: 'builtin-dinner',
    builtin: true,
    name: 'Dinner',
    sampleState: '',
    questions: [
      {
        key: 'q1',
        type: 'choice',
        text: 'What should we have for dinner tonight?',
        options: options(['Pizza', ''], ['Sushi', ''], ['Cook at home', '']),
      },
    ],
  },
  {
    id: 'builtin-rating',
    builtin: true,
    name: 'Rating',
    sampleState: '',
    questions: [{ key: 'q1', type: 'score', text: 'How good is this?', levels: levels(...scale('1-5')) }],
  },
]);
