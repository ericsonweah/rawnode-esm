export function unifiedDiff(oldText, newText, filePath) {
  const a = oldText.split('\n'), b = newText.split('\n');
  // Naive LCS dynamic programming (line-level) – OK for changed files only.
  const n=a.length,m=b.length; const dp=Array.from({length:n+1},()=>Array(m+1).fill(0));
  for (let i=n-1;i>=0;i--) for (let j=m-1;j>=0;j--) dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const out=[];
  let i=0,j=0;
  while(i<n && j<m){
    if(a[i]===b[j]){ out.push(' '+a[i]); i++; j++; }
    else if(dp[i+1][j]>=dp[i][j+1]){ out.push('-'+a[i]); i++; }
    else{ out.push('+'+b[j]); j++; }
  }
  while(i<n){ out.push('-'+a[i++]); }
  while(j<m){ out.push('+'+b[j++]); }
  return [`--- a/${filePath}`,`+++ b/${filePath}`, ...out].join('\n');
}
