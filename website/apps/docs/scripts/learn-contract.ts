export interface LearningRoute {
  path: `/learn/${string}`;
  title: string;
  lessonId: string;
  course: string;
  position: number;
}

const courses = [
  {
    slug: '01-models-to-agents',
    title: 'From models to Agents',
    lessons: [
      ['what-a-model-does', 'What a model does'],
      ['chat-is-conversation', 'Chat makes generation conversational'],
      ['copilots-enter-workflow', 'Copilots enter the workflow'],
      ['tools-let-model-act', 'Tools let a model act'],
      ['agent-owns-outcome', 'An Agent owns an outcome'],
      ['harnesses-make-agents-durable', 'Harnesses make Agents durable'],
      ['long-running-work-needs-evidence', 'Long-running work needs evidence'],
    ],
  },
  {
    slug: '02-agents-to-companies',
    title: 'From Agents to companies',
    lessons: [
      ['parallel-agents-not-company', 'Parallel Agents are not yet a company'],
      ['intent-becomes-owned-outcome', 'Intent must become an owned outcome'],
      ['tasks-and-assignments', 'Tasks and Assignments'],
      ['crew-not-swarm', 'A crew, not a swarm'],
      ['authority-at-consequences', 'Authority belongs where consequences live'],
      ['attention-operating-problem', 'Attention is the operating problem'],
      ['one-source-of-truth', 'One honest source of truth per concern'],
      ['persistence-is-product', 'Persistence is the product'],
      ['how-company-learns', 'How a company learns'],
    ],
  },
  {
    slug: '03-operate-first-fleet',
    title: 'Operate your first Fleet',
    lessons: [
      ['bring-agentos-online', 'Bring AgentOS online'],
      ['meet-first-mate', 'Meet your First Mate'],
      ['give-first-outcome', 'Give the company its first outcome'],
      ['form-right-crew', 'Form the right crew'],
      ['watch-without-being-loop', 'Watch without becoming the loop'],
      ['steer-moving-work', 'Steer work that is already moving'],
      ['make-consequential-decision', 'Make a consequential decision'],
      ['recover-interrupted-worker', 'Recover an interrupted worker'],
      ['deliver-project-workflow', 'Deliver through the project’s workflow'],
      ['upgrade-running-fleet', 'Upgrade a running Fleet'],
    ],
  },
  {
    slug: '04-build-autonomous-company',
    title: 'Build your autonomous company',
    lessons: [
      ['start-with-one-domain', 'Start with one domain'],
      ['compose-right-agent', 'Compose the right Agent'],
      ['connect-real-world-signals', 'Connect real-world signals'],
      ['design-human-attention', 'Design human attention'],
      ['measure-organization', 'Measure the organization'],
      ['improve-from-failure', 'Improve from failure'],
      ['keep-company-sovereign', 'Keep the company sovereign'],
    ],
  },
] as const;

export const learningRoutes: readonly LearningRoute[] = courses.flatMap((course) =>
  course.lessons.map(([lessonId, title]) => ({
    path: `/learn/${course.slug}/${lessonId}` as `/learn/${string}`,
    title,
    lessonId,
    course: course.title,
    position: 0,
  })),
).map((route, index) => ({ ...route, position: index + 1 }));
