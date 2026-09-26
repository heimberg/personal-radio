import type { FeedbackAction, FeedbackEvent } from '../domain/recommendation.ts';
import { rankCandidates } from '../domain/recommendation.ts';
import type { Profile } from '../domain/program.ts';

interface ExampleStory {
  id: string;
  title: string;
  description: string;
  interests: string[];
}

const examples: ExampleStory[] = [
  { id: 'alpine-geology', title: 'Wie die Alpen entstanden', description: 'Gesteinsschichten und Landschaftsformen im Wandel.', interests: ['Geologie', 'Wissenschaft'] },
  { id: 'bern-history', title: 'Bern im Mittelalter', description: 'Wie Handel und Stadtmauern Bern geprägt haben.', interests: ['Geschichte', 'Kultur'] },
  { id: 'weather-satellites', title: 'Wie Satelliten das Wetter beobachten', description: 'Messdaten aus dem All und ihre Bedeutung im Alltag.', interests: ['Technologie', 'Wissenschaft'] },
  { id: 'urban-nature', title: 'Natur zwischen den Häusern', description: 'Was Hecken, Bäume und kleine Grünflächen bewirken.', interests: ['Natur', 'Wissenschaft'] },
];

interface Props {
  profile: Profile;
  feedback: FeedbackEvent[];
  onFeedback(event: Omit<FeedbackEvent, 'createdAt'>): void;
}

export function PublicLearningDemo({ profile, feedback, onFeedback }: Props) {
  const interests = [...profile.topics, ...profile.interests];
  const ranked = rankCandidates(examples, interests, profile.interestWeights, profile.exploration, Math.random(), profile.interests);
  const latest = new Map<string, FeedbackAction>();
  for (const event of feedback) latest.set(event.itemId, event.action);

  return <section className="panel learning-demo" aria-labelledby="learning-demo-title">
    <div className="section-heading"><h2 id="learning-demo-title">So lernt dein Radio</h2><span>Lokale Simulation</span></div>
    <p>Diese Beispielthemen werden nach deinen Interessen und deinem Feedback sortiert. Die Karten enthalten keine aktuellen Nachrichten und rufen keine KI auf.</p>
    <ol className="example-stories">
      {ranked.map((story, index) => <li key={story.id}>
        <div className="example-rank">{String(index + 1).padStart(2, '0')}</div>
        <div className="example-copy"><strong>{story.title}</strong><span>{story.description}</span><small>{story.interests.join(' · ')}</small></div>
        <div className="example-votes">
          <button type="button" aria-label={`Mehr davon: ${story.title}`} aria-pressed={latest.get(story.id) === 'like'} onClick={() => onFeedback({ itemId: story.id, interests: story.interests, action: 'like', listenedRatio: 1 })}>👍</button>
          <button type="button" aria-label={`Weniger davon: ${story.title}`} aria-pressed={latest.get(story.id) === 'dislike'} onClick={() => onFeedback({ itemId: story.id, interests: story.interests, action: 'dislike', listenedRatio: 1 })}>👎</button>
        </div>
      </li>)}
    </ol>
    <p className="privacy-note">Interessen und Bewertungen bleiben in deinem Browser. «Neues entdecken» mischt bewusst neue Themen in die Reihenfolge.</p>
  </section>;
}
