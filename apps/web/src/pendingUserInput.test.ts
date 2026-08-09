import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  pendingUserInputAllowsSubmit,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

describe("pendingUserInputAllowsSubmit", () => {
  it("defaults legacy prompts to submit and honors explicit action restrictions", () => {
    expect(pendingUserInputAllowsSubmit(undefined)).toBe(true);
    expect(pendingUserInputAllowsSubmit(["submit", "cancel"])).toBe(true);
    expect(pendingUserInputAllowsSubmit(["chat", "cancel"])).toBe(false);
  });
});

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });
  it("ignores custom answer when allowCustom is false", () => {
    const noCustomQuestion = {
      ...singleSelectQuestion,
      allowCustom: false,
    };
    expect(
      resolvePendingUserInputAnswer(noCustomQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Disallowed text",
      }),
    ).toBe("Orchestration-first");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionLabels: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionLabels: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Web"],
    });
  });

  it("preserves draft notes when selecting options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { note: "Keep this note", selectedOptionLabels: ["Web"] },
        "Mobile",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Mobile"],
      note: "Keep this note",
    });
  });
});

describe("setPendingUserInputCustomAnswer", () => {
  it("preserves draft notes when editing a custom answer", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          note: "Keep this note",
          selectedOptionLabels: ["Web"],
          customAnswer: "",
        },
        "Something custom",
      ),
    ).toEqual({
      customAnswer: "Something custom",
      note: "Keep this note",
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
            multiSelect: false,
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
            note: "Document the migration window",
          },
        },
      ),
    ).toEqual({
      scope: { selectedOptions: ["Orchestration-first"] },
      compat: {
        selectedOptions: [],
        customInput: "Keep the current envelope for one release window",
        note: "Document the migration window",
      },
    });
  });

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionLabels: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: { selectedOptions: ["Server", "Web"] },
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });
});
it("omits customInput when allowCustom is false", () => {
  const noCustomQuestion = {
    ...singleSelectQuestion,
    allowCustom: false,
  };
  expect(
    buildPendingUserInputAnswers([noCustomQuestion], {
      scope: {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Disallowed text",
      },
    }),
  ).toEqual({
    scope: { selectedOptions: ["Orchestration-first"] },
  });
});

it("omits note when supportsNote is false", () => {
  expect(
    buildPendingUserInputAnswers(
      [singleSelectQuestion],
      {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
          note: "Discarded note",
        },
      },
      false,
    ),
  ).toEqual({
    scope: { selectedOptions: ["Orchestration-first"] },
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionLabels: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabels: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });
});
