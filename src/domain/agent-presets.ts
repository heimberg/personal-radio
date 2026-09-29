// Ready-made styles for the editorial desk: one tap sets instructions and freedom of several agents.
// They only touch the style parts; source rules and formats stay fixed as always.
import type { AgentConfig } from './agents.ts';

export interface AgentPreset { id: string; name: string; description: string; agents: AgentConfig }

export const AGENT_PRESETS: readonly AgentPreset[] = [
  { id: 'nachrichten', name: 'Nachrichtenstil', description: 'Sachlich, knapp, das Wichtigste zuerst.',
    agents: {
      writer: { instructions: 'Nachrichtenstil: das Wichtigste im ersten Satz (wer, was, wann, wo), danach Einordnung und Folgen. Sachlich, neutral, keine Wertungen, keine Ausrufe. Kennzeichne Unsicherheit.', temperature: 0.25 },
      editor: { instructions: 'Schreibe fürs Hören im Nachrichtenton. Kurze Hauptsätze, höchstens 15 Wörter. Der erste Satz enthält die Kernnachricht. Zahlen runden, Quellen im Satz nennen («laut …»). Keine Füllwörter, keine Wertungen, keine rhetorischen Fragen. Zum Schluss ein Satz, was als Nächstes zu erwarten ist, wenn die Quellen es hergeben.', temperature: 0.3 },
      jury: { instructions: 'Bewerte streng wie eine Nachrichtenredaktion. hook: steht die Kernnachricht im ersten Satz? clarity: beim einmaligen Hören verständlich? facts: präzise, belegt, neutral? novelty: wirklich neu? length: knapp, ohne Füllsätze? notes: die zwei wichtigsten Verbesserungen.', threshold: 4 },
    } },
  { id: 'plauderton', name: 'Plauderton', description: 'Locker und persönlich, wie ein Gespräch unter Freunden.',
    agents: {
      writer: { instructions: 'Erzähle locker und persönlich, als würdest du einer Freundin etwas Spannendes berichten: direkte Ansprache, Alltagssprache, eine kleine eigene Beobachtung, gern ein Augenzwinkern. Bleib bei den Fakten der Quellen und kennzeichne Unsicherheit.', temperature: 0.7 },
      dialog: { instructions: 'Ein lockeres Gespräch zweier Menschen, die sich mögen: sie fallen sich auch mal ins Wort, lachen, fragen nach, widersprechen freundlich. Keine gestellten Überleitungen. Stimme Themen und Tiefe auf die Interessen ab.', temperature: 0.7 },
      editor: { instructions: 'Schreibe fürs Ohr und im Plauderton: kurze Sätze, direkte Ansprache, Alltagssprache statt Fachwörter, eine persönliche Note. Der Einstieg macht neugierig. Keine Floskeln, keine Aufzählungen.', temperature: 0.65 },
    } },
  { id: 'wissen', name: 'Wissensmagazin', description: 'Erklärt Zusammenhänge mit Bildern und Vergleichen.',
    agents: {
      writer: { instructions: 'Wissensmagazin: erkläre das Warum und Wie hinter der Nachricht. Nutze ein anschauliches Bild oder einen Vergleich aus dem Alltag, ordne Zahlen ein («so gross wie …»), erkläre Fachbegriffe in einem Halbsatz. Kennzeichne, was gesichert ist und was noch offen ist.', temperature: 0.45 },
      dialog: { instructions: 'Eine Stimme weiss mehr, die andere fragt wie eine neugierige Hörerin nach: «Moment, was heisst das genau?» Begriffe werden erklärt, mit Vergleichen aus dem Alltag. Am Ende ist klar, warum es wichtig ist.', temperature: 0.5 },
      editor: { instructions: 'Schreibe fürs Hören. Ein Gedanke pro Satz. Jeder Fachbegriff wird beim ersten Mal kurz erklärt, jede grosse Zahl mit einem Vergleich greifbar gemacht. Der Einstieg stellt eine Frage oder ein Rätsel, das der Beitrag löst. Am Ende die Kernaussage in einem Satz.' },
      jury: { instructions: 'Bewerte streng. hook: weckt der Einstieg Neugier? clarity: versteht man es ohne Vorwissen? facts: korrekt und belegt? novelty: lernt man etwas Neues? length: passt die Länge? notes: die zwei wichtigsten Verbesserungen.' },
    } },
  { id: 'morgen', name: 'Morgenshow', description: 'Kurz, wach, mit guter Laune in den Tag.',
    agents: {
      writer: { instructions: 'Morgenshow: kurz, wach und positiv, ohne albern zu sein. Ein Satz, der zum Tag passt, dann schnell zum Punkt. Direkte Ansprache. Kennzeichne Unsicherheit.', temperature: 0.6 },
      editor: { instructions: 'Schreibe fürs Hören, frisch und mit Tempo: sehr kurze Sätze, aktive Verben, ein Lächeln in der Stimme. Keine langen Herleitungen. Der letzte Satz gibt einen kleinen Gedanken für den Tag mit.', temperature: 0.6 },
      music: { instructions: 'Morgens: eher hell und beschwingt, mit Energie, aber nicht hektisch; Entdeckungen gemischt mit Vertrautem aus dem Geschmack, abwechslungsreich gegenüber den letzten Songs.' },
    } },
];

/** The preset whose settings are all in place (other agents may be changed too). */
export function activePreset(config: AgentConfig | undefined): AgentPreset | undefined {
  return AGENT_PRESETS.find(preset => Object.entries(preset.agents).every(([id, settings]) =>
    JSON.stringify(config?.[id as keyof AgentConfig] ?? {}) === JSON.stringify(settings)));
}

/** Applies a preset: the agents it names get exactly its settings, the others keep the owner's. */
export function applyPreset(config: AgentConfig | undefined, preset: AgentPreset): AgentConfig {
  return { ...config, ...structuredClone(preset.agents) };
}
