// A sample review document to render and annotate while we build the slice.
export const sampleMarkdown = `# Churn model — review

We trained a gradient-boosted model to predict 30-day churn from the customer
activity table. This writeup covers the data, the approach, and where the result
is weakest.

## Data

The training set is **48,210 customers** over a six-month window. Features are
derived from login cadence, support tickets, and billing events. Rows with no
activity in the window were dropped — that is the quick brown fox of this
analysis, and it may bias the result toward active users.

## Approach

1. Build features per customer.
2. Split 80/20 by signup cohort, not at random.
3. Train, calibrate, and evaluate on the held-out cohort.

> The cohort split matters: a random split leaks future behaviour into training.

## Where it is weak

Recall on the smallest plan tier is poor. The model rarely sees churn there, so
it under-predicts it. We should either reweight or gather more low-tier examples
before trusting these numbers.
`;
