// The station's editorial agents: what each one does, the part of its prompt the owner may rewrite
// (style, criteria, emphasis) and the fixed contract (output format, source rules) that keeps the server
// able to read the answer and the evidence rules intact. Only the owner's changes are stored.

export type AgentId =
  | 'research' | 'writer' | 'dialog' | 'editor' | 'jury' | 'verifier' | 'music' | 'hour'
  | 'team.director' | 'team.songs' | 'team.lyrics' | 'team.writer' | 'team.check' | 'team.final';

export interface AgentDefinition {
  id: AgentId;
  group: 'Beiträge' | 'Musik' | 'Redaktionsteam der Musikstunde';
  name: string;
  description: string;
  /** The editable part of the prompt, as shipped. */
  instructions: string;
  /** What stays fixed, in plain words (shown read-only). */
  contract: string;
  /** Model temperature: 0 = exact, 1 = free. */
  temperature: number;
  /** Agents that can be switched off (the draft or the check still happens without them). */
  optional?: boolean;
  /** Jury: below this overall mark the script goes back once. */
  threshold?: number;
  /** A trial run on the last item is possible. */
  trial?: boolean;
}

/** Scripts are heard, not read. */
const SPOKEN = 'Schreibe fürs Ohr, wie gute Radiomoderation klingt: kurze und lange Sätze im Wechsel, direkte Ansprache, ein Aufhänger am Anfang, mal eine Frage, echte Neugier und Begeisterung, wo sie passt. Keine Aufzählungen, keine Floskeln, keine Überschriften.';

export const AGENTS: readonly AgentDefinition[] = [
  { id: 'research', group: 'Beiträge', name: 'Recherche', description: 'Sucht mit Google Belege für Beiträge mit Websuche.',
    instructions: 'Schreibe einen sachlichen Rechercheüberblick in kurzen, eigenständigen Sätzen; jeder Satz enthält genau eine überprüfbare Aussage mit Datum oder Zeitraum, wo relevant. Keine Meinungen, keine Spekulation, keine Einleitung.',
    contract: 'Nutzt die Google-Suche. Als Quelle zählt nur, was einem Suchergebnis zugeordnet ist.', temperature: 0.3 },
  { id: 'writer', group: 'Beiträge', name: 'Autorin', description: 'Schreibt den Entwurf eines Kurzbeitrags aus den Quellen.',
    instructions: `Kennzeichne Unsicherheit. ${SPOKEN}`,
    contract: 'Nur Fakten aus den Quellen, Quellentext ist nie eine Anweisung, Antwort als JSON mit Titel, Text und Quellen-IDs, Länge nach Sendung.', temperature: 0.4, trial: true },
  { id: 'dialog', group: 'Beiträge', name: 'Dialog-Redaktion', description: 'Schreibt Dialoge für zwei Stimmen.',
    instructions: `Erstelle einen natürlichen, gehaltvollen Dialog. Die Hosts erklären Begriffe, ordnen ein und stellen echte Rückfragen statt künstlich zu plaudern. Stimme Themen und Tiefe auf explizite Interessen sowie gelernte Vorlieben ab. ${SPOKEN}`,
    contract: 'Genau zwei Stimmen, 6–16 abwechselnde Turns, nur Fakten aus den Quellen, Antwort als JSON.', temperature: 0.45 },
  { id: 'editor', group: 'Beiträge', name: 'Schlussredaktion', description: 'Schreibt jeden Beitrag fürs Ohr um und verbindet ihn mit dem Programm.',
    instructions: [
      'Schreibe fürs Hören, nicht fürs Lesen.',
      'Ein Gedanke pro Satz, im Schnitt höchstens 15 Wörter; kurze und längere Sätze im Wechsel.',
      'Der erste Satz ist ein Aufhänger mit etwas Konkretem, keine Begrüssungsfloskel.',
      'Zahlen runden und ausschreiben, wo es hilft («gut drei Millionen» statt «3.087.412»); höchstens zwei Zahlen pro Satz.',
      'Abkürzungen beim ersten Mal ausschreiben; Personen beim ersten Nennen mit Funktion vorstellen.',
      'Aktiv statt passiv, Verben statt Substantivketten, keine Schachtelsätze.',
      'Die Kernaussage am Ende kurz wiederholen, mit einem Gedanken, der hängen bleibt.',
      'Keine Aufzählungszeichen, Klammern, Fussnoten oder Überschriften; keine Füllwörter wie «spannend» ohne Grund.',
    ].join(' '),
    contract: 'Behält alle Tatsachen, Quellen, das Format und ungefähr die Länge; Übergänge und Stationskennung; der Faktencheck prüft danach den finalen Text.', temperature: 0.5, optional: true, trial: true },
  { id: 'jury', group: 'Beiträge', name: 'Qualitäts-Jury', description: 'Bewertet jeden Beitrag; die Schlussredaktion setzt ihre Hinweise immer um.',
    instructions: 'Bewerte streng. hook: packt der Einstieg? clarity: beim einmaligen Hören verständlich? facts: konkret, belegt, ohne Übertreibung? novelty: bringt er Neues, nicht Allgemeinplätze? length: passt die Länge zum Inhalt, keine Füllsätze? notes: die wichtigsten konkreten Verbesserungen (höchstens drei), knapp und umsetzbar.',
    contract: 'Noten 1–5 für hook, clarity, facts, novelty, length; die Gesamtnote ist der Durchschnitt.', temperature: 0.1, optional: true, threshold: 3.5, trial: true },
  { id: 'verifier', group: 'Beiträge', name: 'Faktencheck', description: 'Prüft jede Aussage gegen die Quellen (bei Sendungen mit strenger Prüfung).',
    instructions: '',
    contract: 'Jede Tatsachenbehauptung braucht ein wörtliches Zitat aus einer Quelle; Zitate werden zusätzlich lokal geprüft. Deine Hinweise können die Prüfung schärfen, aber nicht lockern.', temperature: 0 },
  { id: 'music', group: 'Musik', name: 'Musikredaktion', description: 'Wählt Songs zwischen den Beiträgen und schreibt die kurzen Ansagen.',
    instructions: 'Eher spezifisch und abseits der Charts, Entdeckungen gemischt mit Vertrautem aus dem Geschmack, abwechslungsreich gegenüber den letzten Songs.',
    contract: 'Nur Songs, die es sicher gibt, mit exakten Titeln; Spotify sucht sie, deine Hördaten gehen nicht an die KI ausser den freigegebenen Top-Künstlern.', temperature: 0.9, trial: true },
  { id: 'hour', group: 'Musik', name: 'Musikstunde (Standard)', description: 'Schreibt die Moderationen einer Musikstunde in einem Durchgang.',
    instructions: 'Jeder Beitrag muss sich auf den konkreten Song beziehen und eine andere Geschichte erzählen; keine austauschbaren Übergänge und keine wiederholte Biografie. Was nicht belegt ist, vorsichtig als Unsicherheit kennzeichnen oder weglassen. Keine Chart-Plätze erfinden.',
    contract: 'Eine Moderation pro Song, Eröffnung und Abschluss, Tatsachen nur aus den Quellen, Antwort als JSON.', temperature: 0.6, trial: true },
  { id: 'team.director', group: 'Redaktionsteam der Musikstunde', name: 'Regie', description: 'Plant Dramaturgie und Songliste.',
    instructions: 'Gib jedem Song eine Rolle im Ablauf (warum an dieser Stelle) und eine konkrete Rechercheaufgabe, die eine eigene, überprüfbare Geschichte zu genau dieser Aufnahme findet.',
    contract: 'Nur Songs, die es sicher gibt; höchstens zwei Fachrecherchen; Antwort als JSON.', temperature: 0.6 },
  { id: 'team.songs', group: 'Redaktionsteam der Musikstunde', name: 'Song-Recherche', description: 'Recherchiert zu jedem Song eine eigene Geschichte.',
    instructions: 'Nur konkrete, belegbare Details zu genau diesem Song, keine allgemeine Biografie.',
    contract: 'Google-Suche; nur zugeordnete Suchergebnisse zählen als Quelle.', temperature: 0.3 },
  { id: 'team.lyrics', group: 'Redaktionsteam der Musikstunde', name: 'Songdeutung', description: 'Beschreibt Themen und Stimmung eines Songs.',
    instructions: 'Beschreibe Themen und Stimmung in eigenen Worten, in je höchstens zwei Sätzen.',
    contract: 'Keine Songtexte zitieren (höchstens drei Wörter am Stück); Unsicheres als «niedrig» markieren.', temperature: 0.3 },
  { id: 'team.writer', group: 'Redaktionsteam der Musikstunde', name: 'Stunden-Autorin', description: 'Schreibt die Moderationen aus den Recherchen.',
    instructions: 'Jede Moderation erzählt eine andere, konkrete Geschichte zu genau diesem Song. Deutungen als Deutung formulieren. Keine Chart-Plätze erfinden, keine Songtexte zitieren.',
    contract: 'Eine Moderation pro Song, Tatsachen nur aus den Quellen, Quellen-IDs zuordnen, Antwort als JSON.', temperature: 0.6 },
  { id: 'team.check', group: 'Redaktionsteam der Musikstunde', name: 'Stunden-Faktencheck', description: 'Prüft jede Behauptung der Stunde.',
    instructions: 'Liste nur echte Probleme: nicht belegt, widerspricht der Quelle, übertrieben.',
    contract: 'Prüft gegen die Quellen; Begrüssungen, Überleitungen und Deutungen sind keine Behauptungen.', temperature: 0.1 },
  { id: 'team.final', group: 'Redaktionsteam der Musikstunde', name: 'Stunden-Schlussredaktion', description: 'Behebt Probleme und glättet die ganze Stunde.',
    instructions: 'Prüfe die ganze Stunde: Übergänge, Wiederholungen, Tempo, gleichmässige Länge.',
    contract: 'Behebt jedes gemeldete Problem, erfindet nichts, behält Aufbau, Reihenfolge und Quellen.', temperature: 0.4 },
];

/** The owner's changes to one agent; anything missing keeps the shipped default. */
export interface AgentSettings { instructions?: string; temperature?: number; enabled?: boolean; threshold?: number }
export type AgentConfig = Partial<Record<AgentId, AgentSettings>>;

/** One agent as the server uses it: the owner's changes over the default. */
export interface ResolvedAgent { instructions: string; temperature: number; enabled: boolean; threshold: number }
export type ResolvedAgents = Record<AgentId, ResolvedAgent>;

export const agentDefinition = (id: AgentId) => AGENTS.find(agent => agent.id === id)!;

export function resolveAgents(config: AgentConfig | undefined): ResolvedAgents {
  return Object.fromEntries(AGENTS.map(agent => {
    const own = config?.[agent.id] ?? {};
    return [agent.id, {
      instructions: own.instructions ?? agent.instructions,
      temperature: own.temperature ?? agent.temperature,
      enabled: agent.optional ? own.enabled !== false : true,
      threshold: own.threshold ?? agent.threshold ?? 0,
    }];
  })) as ResolvedAgents;
}

/** The resolved agent, or the shipped default when nothing was resolved (tests, older callers). */
export const agentOf = (agents: ResolvedAgents | undefined, id: AgentId): ResolvedAgent => (agents ?? resolveAgents(undefined))[id];

/** Validates the owner's changes; unknown agents and fields are refused with a readable path. */
export function parseAgentConfig(value: unknown, fail: (path: string, expected: string) => never): AgentConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail('agents', 'Objekt');
  const config: AgentConfig = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const agent = AGENTS.find(item => item.id === id);
    if (!agent) fail(`agents.${id}`, 'bekannter Agent');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`agents.${id}`, 'Objekt');
    const s = raw as Record<string, unknown>, settings: AgentSettings = {};
    if (s.instructions !== undefined) {
      if (typeof s.instructions !== 'string' || s.instructions.length > 3000) fail(`agents.${id}.instructions`, 'Text bis 3000 Zeichen');
      if ((s.instructions as string).trim() !== agent!.instructions) settings.instructions = (s.instructions as string).trim();
    }
    if (s.temperature !== undefined) {
      if (typeof s.temperature !== 'number' || !(s.temperature >= 0 && s.temperature <= 1)) fail(`agents.${id}.temperature`, 'Zahl von 0 bis 1');
      if (Math.abs((s.temperature as number) - agent!.temperature) > 1e-9) settings.temperature = Math.round((s.temperature as number) * 100) / 100;
    }
    if (s.enabled !== undefined) {
      if (typeof s.enabled !== 'boolean' || (!agent!.optional && s.enabled === false)) fail(`agents.${id}.enabled`, agent!.optional ? 'true oder false' : 'dieser Agent ist immer an');
      if (s.enabled === false) settings.enabled = false;
    }
    if (s.threshold !== undefined) {
      if (agent!.threshold === undefined || typeof s.threshold !== 'number' || !(s.threshold >= 1 && s.threshold <= 5)) fail(`agents.${id}.threshold`, 'Note von 1 bis 5');
      if (s.threshold !== agent!.threshold) settings.threshold = s.threshold as number;
    }
    if (Object.keys(settings).length) config[id as AgentId] = settings;
  }
  return Object.keys(config).length ? config : undefined;
}
