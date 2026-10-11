/**
 * File Change Tracking & Diff Engine for Nexus Terminal Agent.
 * Tracks file modifications made by the AI agent, calculates line additions/deletions,
 * generates unified diffs for "Review Changes", and provides atomic revert capabilities.
 */

export interface FileDiffLine {
  type: 'add' | 'del' | 'same';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface AgentFileChange {
  id: string;
  path: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  diffLines: FileDiffLine[];
  messageIndex?: number;
  timestamp: number;
}

const uid = () => 'change_' + Math.random().toString(36).slice(2, 9);

/**
 * Computes line-by-line diff between before and after content using LCS.
 */
export function computeLineDiff(before: string, after: string): {
  additions: number;
  deletions: number;
  diffLines: FileDiffLine[];
} {
  const beforeLines = before === '' ? [] : before.split('\n');
  const afterLines = after === '' ? [] : after.split('\n');

  const n = beforeLines.length;
  const m = afterLines.length;

  // Build LCS matrix
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (beforeLines[i] === afterLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to build diff lines
  let i = n;
  let j = m;
  const rawDiff: FileDiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      rawDiff.push({
        type: 'same',
        text: beforeLines[i - 1],
        oldLineNumber: i,
        newLineNumber: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.push({
        type: 'add',
        text: afterLines[j - 1],
        newLineNumber: j,
      });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawDiff.push({
        type: 'del',
        text: beforeLines[i - 1],
        oldLineNumber: i,
      });
      i--;
    }
  }

  rawDiff.reverse();

  let additions = 0;
  let deletions = 0;
  for (const line of rawDiff) {
    if (line.type === 'add') additions++;
    else if (line.type === 'del') deletions++;
  }

  return {
    additions,
    deletions,
    diffLines: rawDiff,
  };
}

/**
 * Creates an AgentFileChange record.
 */
export function recordFileChange(
  path: string,
  before: string,
  after: string,
  messageIndex?: number
): AgentFileChange {
  const { additions, deletions, diffLines } = computeLineDiff(before, after);
  return {
    id: uid(),
    path,
    before,
    after,
    additions,
    deletions,
    diffLines,
    messageIndex,
    timestamp: Date.now(),
  };
}
