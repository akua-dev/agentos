# Learn vertical progression

## Intent

Make the seven stages on the Learn introduction read as one cumulative path
from a model to an autonomous company. The current horizontal grid implies
parallel categories and compresses the final stage.

## Design

Replace the grid with one compact vertical stack inside the existing
704-pixel reading column:

- a narrow numbered rail runs from `01` through `07`;
- a continuous hairline connects the stages and communicates sequence;
- each row places the stage name and its added capability on the same line;
- quiet separators keep the stack scannable without turning each stage into a
  card;
- the final `Autonomous company` row uses a restrained brand tint and stronger
  type to show that the earlier layers accumulate into the outcome.

The stack keeps the current labels and order. It is non-interactive and adds no
animation. Desktop and mobile use the same vertical structure, with the
capability wrapping below the stage name only when the available width requires
it.

## Boundaries

This change modifies only the progression presentation in
`CourseIntroduction`. It does not change chapter routes, course navigation,
progress storage, prose, typography tokens or theme colors.

## Verification

- Render `/learn` at desktop and mobile widths in light and dark themes.
- Confirm the numbered rail stays continuous and the final row remains
  visually distinct.
- Confirm no horizontal overflow or console errors.
- Run the focused course-introduction test, website tests, typecheck and
  production build before updating pull request 48 through no-mistakes.
