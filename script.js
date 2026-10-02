const profiles = window.FACULTY_PROFILES || [];
const SAVED_FACULTY_STORAGE_KEY = "haskayneFacultyProfiles.savedFaculty";

function loadSavedFaculty() {
  const validProfileIds = new Set(profiles.map((profile) => profile.id));
  try {
    const savedProfileIds = JSON.parse(localStorage.getItem(SAVED_FACULTY_STORAGE_KEY) || "[]");
    return new Set(
      Array.isArray(savedProfileIds)
        ? savedProfileIds.filter((profileId) => validProfileIds.has(profileId))
        : []
    );
  } catch {
    return new Set();
  }
}

const state = {
  search: "",
  selected: new Set(),
  saved: loadSavedFaculty(),
  savedOnly: false,
  comparisonVisible: false
};

const elements = {
  searchInput: document.querySelector("#searchInput"),
  clearSearchButton: document.querySelector("#clearSearchButton"),
  facultyGrid: document.querySelector("#facultyGrid"),
  resultsHeading: document.querySelector("#results-heading"),
  resultCount: document.querySelector("#resultCount"),
  searchOrderNotice: document.querySelector("#searchOrderNotice"),
  emptyState: document.querySelector("#emptyState"),
  savedFacultyButton: document.querySelector("#savedFacultyButton"),
  compareTray: document.querySelector("#compareTray"),
  compareCount: document.querySelector("#compareCount"),
  selectedCompare: document.querySelector("#selectedCompare"),
  compareButton: document.querySelector("#compareButton"),
  compareMessage: document.querySelector("#compareMessage"),
  comparisonSection: document.querySelector("#comparisonSection"),
  comparisonHeading: document.querySelector("#compare-heading"),
  printComparisonButton: document.querySelector("#printComparisonButton"),
  clearComparisonButton: document.querySelector("#clearComparisonButton"),
  comparisonContextMessage: document.querySelector("#comparisonContextMessage"),
  comparisonPanel: document.querySelector("#comparisonPanel"),
  profileDialog: document.querySelector("#profileDialog"),
  profileDialogContent: document.querySelector("#profileDialogContent"),
  closeProfileButton: document.querySelector("#closeProfileButton")
};

let previousFocus = null;

const nameCollator = new Intl.Collator("en", { sensitivity: "base" });
const surnameParticles = new Set(["da", "de", "del", "van", "von"]);
const searchTokenAliases = new Map([
  ["experimental", "experiment"],
  ["experiments", "experiment"],
  ["methods", "method"],
  ["studies", "study"],
  ["policies", "policy"],
  ["analyses", "analysis"],
  ["behaviour", "behavior"],
  ["behaviours", "behavior"],
  ["behavioural", "behavior"],
  ["behavioral", "behavior"],
  ["organisation", "organization"],
  ["organisations", "organization"],
  ["organizations", "organization"],
  ["organisational", "organizational"],
  ["labour", "labor"],
  ["modelling", "modeling"],
  ["centre", "center"],
  ["centres", "center"],
  ["centers", "center"]
]);

// Generic terminology equivalences. These apply across profiles and do not add
// faculty-specific claims. Each query variant is still matched token-for-token.
const controlledSearchAliasGroups = [
  [["remote", "teams"], ["virtual", "teams"]],
  [["employee", "wellbeing"], ["employee", "well", "being"]],
  [["income", "share", "agreements"], ["income", "contingent", "agreements"]],
  [["sustainable", "investing"], ["sustainable", "finance"]]
];

const SEARCH_SCORE_BASE = {
  primary: 300000,
  semantic: 200000,
  secondary: 100000
};

function structuredSectionText(sections = []) {
  return sections.flatMap((section) => [
    section.title,
    ...(section.blocks || []).flatMap((block) => block.content),
    ...(Array.isArray(section.content) ? section.content : [section.content])
  ]).filter(Boolean);
}

function primarySearchText(profile) {
  return [
    profile.name,
    profile.displayName,
    profile.primaryTitle,
    profile.academicTitle,
    profile.academicArea,
    ...profile.topicTags,
    ...profile.methodTags,
    profile.researchSummary,
    ...profile.cardTags,
    profile.cardStrongFit,
    profile.methodologicalOrientation,
    profile.comparisonMethodologicalOrientation,
    profile.comparisonFocus
  ].filter(Boolean).join(" ");
}

function secondarySearchText(profile) {
  return [
    profile.comparisonFit,
    profile.appliedRelevanceTitle,
    profile.supervisionFit.alignment,
    profile.supervisionFit.reminder,
    ...profile.researchAtGlance,
    ...profile.questionsThisResearchExplores,
    profile.questionsExplanation,
    ...profile.methodologicalExpertise,
    ...profile.appliedRelevance,
    ...profile.publications,
    ...profile.supervisionFit.strongPotentialTopics,
    ...profile.beforeContacting,
    ...profile.themes.flatMap((theme) => [theme.title, ...theme.body]),
    ...structuredSectionText(profile.extendedSections)
  ].filter(Boolean).join(" ");
}

function tokenize(text) {
  const tokens = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[\p{L}\p{N}]+/gu) || [];

  const normalizedTokens = tokens.map((token) => searchTokenAliases.get(token) || token);

  // "Experimental methods" and "experiments" describe the same generic
  // vocabulary form; retain exact tokens while avoiding broad stemming.
  return normalizedTokens.filter((token, index) => !(
    token === "method" && index > 0 && normalizedTokens[index - 1] === "experiment"
  ));
}

function tokenSequenceIndex(tokens, sequence) {
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((term, offset) => tokens[index + offset] === term)) return index;
  }
  return -1;
}

function equivalentSearchVariants(searchTerms) {
  const variants = new Map([[searchTerms.join(" "), searchTerms]]);
  const queue = [searchTerms];

  while (queue.length) {
    const terms = queue.shift();
    controlledSearchAliasGroups.forEach((group) => {
      group.forEach((source) => {
        const sourceIndex = tokenSequenceIndex(terms, source);
        if (sourceIndex < 0) return;

        group.forEach((target) => {
          if (target === source) return;
          const variant = [
            ...terms.slice(0, sourceIndex),
            ...target,
            ...terms.slice(sourceIndex + source.length)
          ];
          const key = variant.join(" ");
          if (!variants.has(key)) {
            variants.set(key, variant);
            queue.push(variant);
          }
        });
      });
    });
  }

  return [...variants.values()];
}

function keywordMatch(profile, searchTerms) {
  const primaryTerms = new Set(tokenize(primarySearchText(profile)));
  const secondaryTerms = new Set(tokenize(secondarySearchText(profile)));
  let evidenceScore = 0;
  let allPrimary = true;

  for (const term of searchTerms) {
    if (primaryTerms.has(term)) {
      evidenceScore += 10;
    } else if (secondaryTerms.has(term)) {
      evidenceScore += 1;
      allPrimary = false;
    } else {
      return null;
    }
  }

  return { evidenceScore, allPrimary };
}

function semanticMatchScore(profile, searchVariants) {
  const excludedConcepts = new Set(
    (profile.searchConceptExclusions || []).map((concept) => tokenize(concept).join(" "))
  );
  if (searchVariants.some((terms) => excludedConcepts.has(terms.join(" ")))) {
    return -1;
  }

  const concepts = (profile.searchConcepts || []).map((concept) => new Set(tokenize(concept)));
  let bestScore = -1;

  searchVariants.forEach((searchTerms) => {
    concepts.forEach((conceptTerms) => {
      if (searchTerms.every((term) => conceptTerms.has(term))) {
        bestScore = Math.max(bestScore, searchTerms.length);
      }
    });
  });

  return bestScore;
}

function searchScore(profile) {
  const searchTerms = tokenize(state.search);
  if (!searchTerms.length) return 0;

  const equivalentVariants = equivalentSearchVariants(searchTerms);
  const keywordMatches = equivalentVariants
    .map((terms) => keywordMatch(profile, terms))
    .filter(Boolean);
  const primaryEvidence = keywordMatches
    .filter((match) => match.allPrimary)
    .reduce((best, match) => Math.max(best, match.evidenceScore), -1);

  if (primaryEvidence >= 0) return SEARCH_SCORE_BASE.primary + primaryEvidence;

  const semanticEvidence = semanticMatchScore(profile, equivalentVariants);
  if (semanticEvidence >= 0) return SEARCH_SCORE_BASE.semantic + semanticEvidence;

  const secondaryEvidence = keywordMatches
    .reduce((best, match) => Math.max(best, match.evidenceScore), -1);
  if (secondaryEvidence >= 0) return SEARCH_SCORE_BASE.secondary + secondaryEvidence;

  return -1;
}

function lastName(profile) {
  const nameParts = profile.name.trim().split(/\s+/);
  const particleIndex = nameParts.findIndex((part, index) => (
    index > 0 && index < nameParts.length - 1 && surnameParticles.has(part.toLowerCase())
  ));
  return particleIndex > 0 ? nameParts.slice(particleIndex).join(" ") : nameParts.at(-1);
}

function compareProfiles(a, b) {
  return nameCollator.compare(lastName(a), lastName(b)) || nameCollator.compare(a.name, b.name);
}

function imageOrInitials(profile, className = "card-photo") {
  const portraitFrame = document.createElement("div");
  const context = className === "profile-photo" ? "profile" : "card";
  portraitFrame.className = `portrait-frame ${className}-frame`;

  const makePlaceholder = () => {
    const placeholder = document.createElement("div");
    placeholder.className = "initials-placeholder";
    placeholder.textContent = profile.initials;
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute("aria-label", `${profile.name} initials`);
    return placeholder;
  };

  if (profile.image) {
    const image = document.createElement("img");
    image.className = className;
    image.src = profile.image;
    image.alt = profile.imageAlt;
    const framing = profile.portraitFraming?.[context];
    if (framing?.position) image.style.objectPosition = framing.position;
    if (framing?.scale) image.style.setProperty("--portrait-scale", framing.scale);
    image.addEventListener("error", () => {
      portraitFrame.replaceChildren(makePlaceholder());
    }, { once: true });
    portraitFrame.append(image);
    return portraitFrame;
  }

  portraitFrame.append(makePlaceholder());
  return portraitFrame;
}

function elementWithText(tagName, text, className = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function displayAcademicTitle(profile) {
  // Only remove an exact repetition of the area. Distinctive titles and
  // specializations that differ from the academic area remain untouched.
  const title = profile.primaryTitle;
  const ordinaryTitle = title.match(/^(Professor|Associate Professor|Assistant Professor) of (.+)$/);
  return ordinaryTitle && ordinaryTitle[2] === profile.academicArea
    ? ordinaryTitle[1]
    : title;
}

function persistSavedFaculty() {
  try {
    localStorage.setItem(SAVED_FACULTY_STORAGE_KEY, JSON.stringify([...state.saved]));
  } catch {
    // Saving still works for the current session when browser storage is unavailable.
  }
}

function renderSavedFacultyControl() {
  const savedCount = state.saved.size;
  elements.savedFacultyButton.hidden = savedCount === 0;
  elements.savedFacultyButton.setAttribute("aria-pressed", String(state.savedOnly));
  elements.savedFacultyButton.textContent = state.savedOnly
    ? "Show all faculty"
    : `Saved faculty (${savedCount})`;
  elements.savedFacultyButton.setAttribute(
    "aria-label",
    state.savedOnly
      ? `Show all faculty profiles; ${savedCount} saved`
      : `Show ${savedCount} saved faculty ${savedCount === 1 ? "profile" : "profiles"}`
  );
}

function toggleSaved(profileId) {
  if (state.saved.has(profileId)) {
    state.saved.delete(profileId);
  } else {
    state.saved.add(profileId);
  }

  if (!state.saved.size) state.savedOnly = false;
  persistSavedFaculty();
  renderCards();

  const replacementButton = [...elements.facultyGrid.querySelectorAll("[data-save-id]")]
    .find((button) => button.dataset.saveId === profileId);
  (replacementButton || elements.savedFacultyButton).focus();
}

function toggleSavedFacultyFilter() {
  state.savedOnly = !state.savedOnly;
  renderCards();
  elements.savedFacultyButton.focus();
}

function renderCards() {
  const searchMatches = profiles
    .map((profile) => ({ profile, score: searchScore(profile) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || compareProfiles(a.profile, b.profile))
    .map(({ profile }) => profile);
  const visibleProfiles = state.savedOnly
    ? searchMatches.filter((profile) => state.saved.has(profile.id))
    : searchMatches;

  elements.resultCount.textContent = state.savedOnly
    ? `${visibleProfiles.length} of ${state.saved.size} saved ${state.saved.size === 1 ? "profile" : "profiles"} shown`
    : state.search.length
      ? `${visibleProfiles.length} of ${profiles.length} faculty profiles`
      : `${profiles.length} faculty profiles`;
  elements.searchOrderNotice.hidden = state.search.length === 0;
  elements.emptyState.hidden = visibleProfiles.length !== 0;
  elements.emptyState.textContent = state.savedOnly
    ? (state.search.length
      ? "No saved faculty profiles match your search. Try a broader search or return to all faculty."
      : "No faculty profiles are currently saved.")
    : "No faculty profiles match your search. Try a broader topic, method, or research problem.";
  elements.clearSearchButton.hidden = state.search.length === 0;
  renderSavedFacultyControl();

  const cards = visibleProfiles.map((profile) => {
    const card = document.createElement("article");
    card.className = "faculty-card";

    const body = document.createElement("div");
    body.className = "card-body";

    const title = document.createElement("div");
    title.className = "card-title";
    title.append(
      elementWithText("h3", profile.displayName),
      elementWithText("p", displayAcademicTitle(profile), "academic-title"),
      elementWithText("p", profile.academicArea, "area-label")
    );

    const saveButton = document.createElement("button");
    const isSaved = state.saved.has(profile.id);
    saveButton.type = "button";
    saveButton.className = "save-button";
    saveButton.dataset.saveId = profile.id;
    saveButton.textContent = isSaved ? "★ Unsave" : "☆ Save";
    saveButton.setAttribute("aria-pressed", String(isSaved));
    saveButton.setAttribute(
      "aria-label",
      isSaved ? `Remove ${profile.name} from saved faculty` : `Save ${profile.name} for later`
    );
    saveButton.addEventListener("click", () => toggleSaved(profile.id));

    const titleRow = document.createElement("div");
    titleRow.className = "card-title-row";
    titleRow.append(imageOrInitials(profile), title);

    const summary = elementWithText("p", profile.researchSummary, "summary");

    const tags = document.createElement("ul");
    tags.className = "tag-list";
    // The first three existing card tags describe research themes; the fourth
    // sometimes repeats a method, which is already covered by the Methods line.
    profile.cardTags.slice(0, 3).forEach((tag) => {
      tags.append(elementWithText("li", tag));
    });

    const methods = labelledParagraph("Methods: ", profile.methodologicalOrientation);
    methods.className = "card-methods";

    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.className = "primary-button";
    viewButton.textContent = "View profile";
    viewButton.addEventListener("click", () => openProfile(profile.id));

    const compareButton = document.createElement("button");
    compareButton.type = "button";
    compareButton.className = "secondary-button";
    compareButton.dataset.compareId = profile.id;
    updateCompareButton(compareButton, profile);
    compareButton.addEventListener("click", () => toggleCompare(profile.id));

    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.append(saveButton, viewButton, compareButton);

    body.append(
      titleRow,
      elementWithText("h4", "Research orientation", "card-section-label"),
      summary,
      elementWithText("h4", "Selected research themes", "card-section-label themes-label"),
      tags
    );
    if (profile.methodologicalOrientation) body.append(methods);
    body.append(actions);
    card.append(body);
    return card;
  });

  elements.facultyGrid.replaceChildren(...cards);
  renderCompareState();
}

function labelledParagraph(label, text) {
  const paragraph = document.createElement("p");
  const strong = elementWithText("strong", label);
  paragraph.append(strong, document.createTextNode(text));
  return paragraph;
}

function updateCompareButton(button, profile) {
  const isSelected = state.selected.has(profile.id);
  const isLimitReached = state.selected.size >= 3 && !isSelected;
  button.textContent = isSelected ? "Remove from compare" : "Add to compare";
  button.disabled = isLimitReached;
  button.setAttribute("aria-pressed", String(isSelected));
}

function hideComparison() {
  state.comparisonVisible = false;
  elements.comparisonSection.hidden = true;
  elements.printComparisonButton.hidden = true;
  elements.comparisonContextMessage.hidden = true;
  elements.comparisonContextMessage.textContent = "";
  elements.comparisonPanel.hidden = true;
  elements.comparisonPanel.replaceChildren();
}

function toggleCompare(profileId) {
  const comparisonWasVisible = state.comparisonVisible;
  if (state.selected.has(profileId)) {
    state.selected.delete(profileId);
    elements.compareMessage.textContent = "";
  } else if (state.selected.size >= 3) {
    elements.compareMessage.textContent = "Remove one selected faculty member before adding another.";
  } else {
    state.selected.add(profileId);
    elements.compareMessage.textContent = "";
  }

  renderCards();
  if (comparisonWasVisible && state.selected.size) {
    renderComparison({ scroll: false, focusHeading: true });
  }
}

function renderCompareState() {
  const selectedProfiles = profiles.filter((profile) => state.selected.has(profile.id));
  const selectedCount = selectedProfiles.length;
  elements.compareCount.textContent = `${selectedCount} faculty selected for comparison`;
  elements.compareTray.hidden = selectedCount === 0;
  document.body.classList.toggle("has-compare-tray", selectedCount > 0);
  elements.compareButton.disabled = selectedCount < 2;
  elements.compareButton.textContent = selectedCount >= 2
    ? `Compare ${selectedCount} faculty`
    : "Compare faculty";
  elements.compareMessage.textContent = selectedCount === 1
    ? "Select 1 more faculty to compare."
    : "";

  if (!selectedCount) {
    elements.selectedCompare.replaceChildren();
    hideComparison();
    return;
  }

  const chips = selectedProfiles.map((profile) => {
    const chip = document.createElement("span");
    chip.className = "selected-chip";
    chip.append(document.createTextNode(profile.name));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${profile.name} from comparison`);
    remove.addEventListener("click", () => toggleCompare(profile.id));

    chip.append(remove);
    return chip;
  });

  elements.selectedCompare.replaceChildren(...chips);
}

function renderComparison({ scroll = true, focusHeading = false } = {}) {
  const selectedProfiles = profiles.filter((profile) => state.selected.has(profile.id));
  if (!selectedProfiles.length) {
    hideComparison();
    return;
  }

  state.comparisonVisible = true;
  elements.comparisonSection.hidden = false;

  if (selectedProfiles.length < 2) {
    elements.printComparisonButton.hidden = true;
    elements.comparisonPanel.hidden = true;
    elements.comparisonPanel.replaceChildren();
    elements.comparisonContextMessage.textContent = "Select one more faculty to compare.";
    elements.comparisonContextMessage.hidden = false;
    if (focusHeading) elements.comparisonHeading.focus({ preventScroll: true });
    return;
  }

  elements.comparisonContextMessage.hidden = true;
  elements.comparisonContextMessage.textContent = "";
  elements.printComparisonButton.hidden = false;

  const grid = document.createElement("div");
  grid.className = "comparison-grid";
  grid.setAttribute("aria-label", "Comparison of selected faculty members");

  selectedProfiles.forEach((profile) => {
    const card = document.createElement("article");
    card.className = "comparison-card";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "comparison-remove-button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${profile.name} from comparison`);
    remove.addEventListener("click", () => toggleCompare(profile.id));

    const heading = document.createElement("div");
    heading.className = "comparison-card-heading";
    const viewProfileButton = document.createElement("button");
    viewProfileButton.type = "button";
    viewProfileButton.className = "text-button comparison-profile-button";
    viewProfileButton.textContent = "View full profile";
    viewProfileButton.setAttribute("aria-label", `View full profile for ${profile.name}`);
    viewProfileButton.addEventListener("click", () => openProfile(profile.id));
    heading.append(
      imageOrInitials(profile),
      elementWithText("h3", profile.name),
      elementWithText("p", displayAcademicTitle(profile), "academic-title"),
      elementWithText("p", profile.academicArea, "area-label"),
      viewProfileButton
    );

    card.append(
      remove,
      heading,
      comparisonBlock("Main research focus", profile.comparisonFocus),
      comparisonBlock(
        "Methodological orientation",
        profile.comparisonMethodologicalOrientation || profile.methodologicalOrientation
      ),
      comparisonBlock("Potential research alignment", profile.comparisonFit),
      comparisonBlock("Questions this research explores", orderedList(profile.questionsThisResearchExplores))
    );
    grid.append(card);
  });

  const reflection = document.createElement("aside");
  reflection.className = "comparison-reflection";
  reflection.setAttribute("aria-labelledby", "comparison-reflection-heading");
  const reflectionHeading = elementWithText("h3", "Before you approach a faculty member");
  reflectionHeading.id = "comparison-reflection-heading";
  reflection.append(
    reflectionHeading,
    elementWithText("p", "Can you explain:"),
    unorderedList([
      "why their work connects to your project;",
      "what expertise you hope they could contribute; and",
      "what you would like to discuss with them?"
    ])
  );

  elements.comparisonPanel.replaceChildren(grid, reflection);
  elements.comparisonPanel.hidden = false;
  if (focusHeading) elements.comparisonHeading.focus({ preventScroll: true });
  if (scroll) elements.comparisonSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function comparisonBlock(title, content) {
  const section = document.createElement("section");
  section.append(elementWithText("h4", title));
  if (typeof content === "string") {
    section.append(elementWithText("p", content));
  } else {
    section.append(content);
  }
  return section;
}

function paragraphSection(title, content, className = "") {
  const section = document.createElement("section");
  section.className = `profile-section ${className}`.trim();
  section.append(elementWithText("h3", title));

  if (Array.isArray(content)) {
    content.forEach((item) => section.append(elementWithText("p", item)));
  } else {
    section.append(content);
  }

  return section;
}

function accordionSection(title, content) {
  const details = document.createElement("details");
  details.className = "profile-section accordion-section";
  const summary = document.createElement("summary");
  summary.append(elementWithText("span", title));
  details.append(summary);

  if (Array.isArray(content)) {
    content.forEach((item) => details.append(elementWithText("p", item)));
  } else {
    details.append(content);
  }

  return details;
}

function unorderedList(items) {
  const ul = document.createElement("ul");
  items.forEach((item) => ul.append(elementWithText("li", item)));
  return ul;
}

function orderedList(items) {
  const ol = document.createElement("ol");
  items.forEach((item) => ol.append(elementWithText("li", item)));
  return ol;
}

function structuredProfileContent(blocks) {
  const content = document.createElement("div");
  content.className = "structured-profile-content";
  blocks.forEach((block) => {
    if (block.type === "list") {
      content.append(unorderedList(block.content));
    } else {
      content.append(elementWithText("p", block.content));
    }
  });
  return content;
}

function structuredProfileSection(section) {
  const content = structuredProfileContent(section.blocks);
  return section.display === "accordion"
    ? accordionSection(section.title, content)
    : paragraphSection(section.title, content);
}

function openProfile(profileId) {
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) return;

  previousFocus = document.activeElement;
  elements.profileDialogContent.replaceChildren(renderProfile(profile));
  elements.profileDialog.showModal();
  elements.closeProfileButton.focus();
}

function renderProfile(profile) {
  const wrapper = document.createElement("article");
  wrapper.className = "profile-view";

  const header = document.createElement("header");
  header.className = "profile-header";
  const headingBlock = document.createElement("div");
  headingBlock.append(
    elementWithText("h2", profile.displayName),
    elementWithText("p", displayAcademicTitle(profile), "academic-title"),
    elementWithText("p", profile.academicArea, "area-label")
  );
  headingBlock.querySelector("h2").id = "profileDialogTitle";
  header.append(imageOrInitials(profile, "profile-photo"), headingBlock);

  const disclosure = document.createElement("aside");
  disclosure.className = "profile-disclosure";
  disclosure.setAttribute("aria-label", "AI disclosure");
  disclosure.append(
    elementWithText("strong", "AI disclosure"),
    elementWithText("p", "This profile is an AI-assisted summary based on publicly available sources. It was not written by the faculty member.")
  );

  const fitContent = document.createElement("div");
  fitContent.append(
    elementWithText("p", profile.supervisionFit.reminder),
    unorderedList(profile.supervisionFit.strongPotentialTopics),
    elementWithText("p", profile.supervisionFit.alignment)
  );

  const questionsContent = document.createElement("div");
  questionsContent.append(
    orderedList(profile.questionsThisResearchExplores),
    elementWithText("p", profile.questionsExplanation)
  );

  const themes = document.createElement("div");
  themes.className = "theme-list";
  profile.themes.forEach((theme) => {
    const item = document.createElement("section");
    item.append(elementWithText("h4", theme.title));
    theme.body.forEach((text) => item.append(elementWithText("p", text)));
    themes.append(item);
  });

  if (profile.extendedSections?.length) {
    wrapper.append(
      header,
      disclosure,
      ...profile.extendedSections.map(structuredProfileSection)
    );
  } else {
    wrapper.append(
      header,
      disclosure,
      paragraphSection("Research at a Glance", profile.researchAtGlance),
      paragraphSection("Potential Research Alignment", fitContent),
      paragraphSection("Questions This Research Explores", questionsContent, "questions-section"),
      accordionSection("Primary Research Themes", themes),
      accordionSection("Methodological Expertise", profile.methodologicalExpertise),
      accordionSection(profile.appliedRelevanceTitle, profile.appliedRelevance),
      accordionSection("Selected Publications", unorderedList(profile.publications))
    );
  }

  if (profile.externalLinks?.googleScholar) {
    wrapper.append(googleScholarSection(profile));
  }

  return wrapper;
}

function googleScholarSection(profile) {
  const section = document.createElement("section");
  section.className = "profile-section google-scholar-section";
  section.append(elementWithText("h3", "Google Scholar"));

  const link = document.createElement("a");
  link.href = profile.externalLinks.googleScholar;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View publications on Google Scholar";
  link.setAttribute("aria-label", `View ${profile.name}'s publications on Google Scholar`);
  section.append(link);

  return section;
}

function closeProfile() {
  elements.profileDialog.close();
}

function restoreProfileOpenerFocus() {
  if (previousFocus && typeof previousFocus.focus === "function") {
    previousFocus.focus();
  }
}

function clearSearch() {
  state.search = "";
  elements.searchInput.value = "";
  elements.compareMessage.textContent = "";
  renderCards();
  elements.searchInput.focus();
}

function clearComparison() {
  state.selected.clear();
  hideComparison();
  renderCards();
  elements.resultsHeading.setAttribute("tabindex", "-1");
  elements.resultsHeading.focus({ preventScroll: true });
  elements.resultsHeading.scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleDialogKeydown(event) {
  if (event.key !== "Tab" || !elements.profileDialog.open) return;
  const focusable = [...elements.profileDialog.querySelectorAll(
    "a[href], button:not([disabled]), summary, textarea, input, select, [tabindex]:not([tabindex='-1'])"
  )].filter((node) => !node.hasAttribute("disabled"));

  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function init() {
  renderCards();

  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value;
    renderCards();
  });

  elements.clearSearchButton.addEventListener("click", clearSearch);
  elements.savedFacultyButton.addEventListener("click", toggleSavedFacultyFilter);
  elements.compareButton.addEventListener("click", renderComparison);
  elements.printComparisonButton.addEventListener("click", () => window.print());
  elements.clearComparisonButton.addEventListener("click", clearComparison);
  elements.closeProfileButton.addEventListener("click", closeProfile);
  elements.profileDialog.addEventListener("close", restoreProfileOpenerFocus);
  elements.profileDialog.addEventListener("keydown", handleDialogKeydown);
}

init();
