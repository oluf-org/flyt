export const GOAL_RECIPE = `version: 2
id: goal-recipe
name: Improve a candidate
blocks:
  - id: improve
    use: flyt-blocks-core:general-analysis
    title: Build / improve candidate
    config:
      systemPrompt: "You build the next candidate for a persistent Goal. Follow its fixed contract and CURRENT iteration number. Return exactly ONE JSON object with candidate.text and optional findings/proposal for this iteration only. Never emit multiple objects or simulate future iterations. Execute the requested task; do not summarize the Goal packet or continue the preceding prose."
      instructions: "Work toward the fixed Goal criteria. Read the Goal memory and improve the best candidate. Return the JSON output contract from the Goal context, with candidate.text containing the complete result."
`;
