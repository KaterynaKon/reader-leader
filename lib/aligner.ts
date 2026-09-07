export type AlignmentType = "MATCH" | "SUBSTITUTION" | "OMISSION" | "INSERTION";

export interface AlignedItem {
  type: AlignmentType;
  refIndex?: number;
  refWord?: string;
  azureIndex?: number;
  azureWord?: string;
  accuracy?: number;
}

function normalise(word: string): string {
  return word.toLowerCase().replace(/[.,!?]/g, "").trim();
}

export function alignWords(
  referenceWords: string[],
  azureWords: { Word: string; PronunciationAssessment?: { AccuracyScore?: number } }[]
): AlignedItem[] {
  const n = referenceWords.length;
  const m = azureWords.length;

  if (m === 0) return [];

  // Вагові коефіцієнти штрафів:
  // OMISSION = 3 означає, що алгоритму в 3 рази вигідніше почекати або вважати слово замінником,
  // ніж передчасно промаркувати його як пропущене.
  const OMISSION_COST = 3;
  const INSERTION_COST = 1;
  const SUBSTITUTION_COST = 2;

  // Матриця відстаней
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 0; i <= n; i++) dp[i][0] = i * OMISSION_COST;
  for (let j = 0; j <= m; j++) dp[0][j] = j * INSERTION_COST;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const ref = normalise(referenceWords[i - 1]);
      const heard = normalise(azureWords[j - 1].Word || "");

      const matchCost = ref === heard ? 0 : SUBSTITUTION_COST;

      dp[i][j] = Math.min(
        dp[i - 1][j] + OMISSION_COST,      // Omission (пропущено)
        dp[i][j - 1] + INSERTION_COST,     // Insertion (зайве слово)
        dp[i - 1][j - 1] + matchCost       // Match / Substitution
      );
    }
  }

  // Зворотний хід (Backtracking)
  let i = n;
  let j = m;
  const alignment: AlignedItem[] = [];

  while (i > 0 || j > 0) {
    const refWord = i > 0 ? referenceWords[i - 1] : undefined;
    const azureItem = j > 0 ? azureWords[j - 1] : undefined;
    const accuracy = azureItem?.PronunciationAssessment?.AccuracyScore;

    if (i > 0 && j > 0) {
      const refNorm = normalise(refWord!);
      const heardNorm = normalise(azureItem!.Word || "");
      const matchCost = refNorm === heardNorm ? 0 : SUBSTITUTION_COST;

      if (dp[i][j] === dp[i - 1][j - 1] + matchCost) {
        alignment.unshift({
          type: matchCost === 0 ? "MATCH" : "SUBSTITUTION",
          refIndex: i - 1,
          refWord,
          azureIndex: j - 1,
          azureWord: azureItem!.Word,
          accuracy,
        });
        i--;
        j--;
        continue;
      }
    }

    if (i > 0 && dp[i][j] === dp[i - 1][j] + OMISSION_COST) {
      alignment.unshift({
        type: "OMISSION",
        refIndex: i - 1,
        refWord,
      });
      i--;
    } else {
      alignment.unshift({
        type: "INSERTION",
        azureIndex: j - 1,
        azureWord: azureItem?.Word,
        accuracy,
      });
      j--;
    }
  }

  return alignment;
}