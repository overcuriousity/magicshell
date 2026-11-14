# Roadmap

Wanted later, not in the first version. A run already keeps its full request and answers, and results are drawn per question, so none of these needs a rewrite.

1. **Images as the situation.** Clef-Flash accepts images; the situation field would take one or more beside the text.
2. **Cutoff bands.** Per-question thresholds that sort an answer into act, review or hand over.
3. **Batch runs over many examples.** Labelled examples run in one go, with accuracy against the labels.
4. **Comparing more than two runs, and runs across models.** More columns beside the baseline, and the same setup asked of different models.
5. **Suggested options by meaning in the guided view.** Optional: with embeddings and a vector store, the guide offers the earlier options closest in meaning to the question just typed, about the top five, beside the often-used ones.
