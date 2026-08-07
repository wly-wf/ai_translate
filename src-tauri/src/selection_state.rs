#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub text: String,
    pub anchor: Anchor,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateChange {
    Show(Selection),
    Hide,
    Unchanged,
}

const MAX_SELECTION_CHARACTERS: usize = 12_000;

#[derive(Default)]
pub struct SelectionController {
    current: Option<Selection>,
    next_generation: u64,
    latest_generation: u64,
}

impl SelectionController {
    pub fn begin_mouse_up(&mut self) -> u64 {
        self.next_generation = self.next_generation.saturating_add(1);
        self.latest_generation = self.next_generation;
        self.latest_generation
    }

    pub fn begin_selection_capture(&mut self) -> u64 {
        let generation = self.begin_mouse_up();
        self.current = None;
        generation
    }

    pub fn is_latest_generation(&self, generation: u64) -> bool {
        generation == self.latest_generation
    }

    pub fn replace_selection(
        &mut self,
        generation: u64,
        text: String,
        anchor: Anchor,
    ) -> StateChange {
        if generation != self.latest_generation {
            return StateChange::Unchanged;
        }
        if text.chars().count() > MAX_SELECTION_CHARACTERS {
            return StateChange::Unchanged;
        }

        let selection = Selection {
            text,
            anchor,
            generation,
        };
        self.current = Some(selection.clone());
        StateChange::Show(selection)
    }

    pub fn clear_after_plain_click(
        &mut self,
        generation: u64,
        clicked_float: bool,
    ) -> StateChange {
        if generation != self.latest_generation {
            return StateChange::Unchanged;
        }
        if clicked_float || self.current.is_none() {
            StateChange::Unchanged
        } else {
            self.current = None;
            StateChange::Hide
        }
    }

    pub fn take_for_translation(&mut self) -> Option<Selection> {
        self.current.take()
    }

    pub fn restore_after_translation_failure(&mut self, selection: Selection) -> bool {
        if selection.generation != self.latest_generation || self.current.is_some() {
            return false;
        }
        self.current = Some(selection);
        true
    }
}

#[cfg(test)]
fn visible_controller(text: &str) -> SelectionController {
    let mut controller = SelectionController::default();
    let generation = controller.begin_mouse_up();
    controller.replace_selection(generation, text.to_owned(), Anchor { x: 0, y: 0 });
    controller
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_selection_replaces_visible_selection() {
        let mut controller = SelectionController::default();
        let first_generation = controller.begin_mouse_up();
        controller.replace_selection(first_generation, "first".into(), Anchor { x: 1, y: 1 });
        let second_generation = controller.begin_mouse_up();
        let change = controller.replace_selection(
            second_generation,
            "second".into(),
            Anchor { x: 2, y: 2 },
        );

        assert_eq!(change, StateChange::Show(Selection {
            text: "second".into(), anchor: Anchor { x: 2, y: 2 }, generation: 2,
        }));
    }

    #[test]
    fn plain_click_hides_visible_float_but_clicking_float_does_not() {
        let mut controller = visible_controller("selected");
        let generation = controller.begin_mouse_up();
        assert_eq!(
            controller.clear_after_plain_click(generation, false),
            StateChange::Hide
        );

        let mut controller = visible_controller("selected");
        let generation = controller.begin_mouse_up();
        assert_eq!(
            controller.clear_after_plain_click(generation, true),
            StateChange::Unchanged
        );
    }

    #[test]
    fn float_click_returns_exact_saved_text_once() {
        let mut controller = visible_controller("selected");
        assert_eq!(controller.take_for_translation().map(|selection| selection.text), Some("selected".into()));
        assert_eq!(controller.take_for_translation(), None);
    }

    #[test]
    fn beginning_a_new_capture_discards_the_previous_selection() {
        let mut controller = visible_controller("previous");

        let generation = controller.begin_selection_capture();

        assert_eq!(generation, 2);
        assert_eq!(controller.take_for_translation(), None);
        assert!(matches!(
            controller.replace_selection(generation, "current".into(), Anchor { x: 2, y: 3 }),
            StateChange::Show(_)
        ));
        assert_eq!(
            controller.take_for_translation().map(|selection| selection.text),
            Some("current".into())
        );
    }

    #[test]
    fn failed_translation_can_restore_the_same_selection_for_retry() {
        let mut controller = visible_controller("selected");
        let selection = controller.take_for_translation().unwrap();

        assert!(controller.restore_after_translation_failure(selection));
        assert_eq!(controller.take_for_translation().map(|selection| selection.text), Some("selected".into()));
    }

    #[test]
    fn failed_translation_does_not_restore_over_a_newer_selection() {
        let mut controller = visible_controller("old");
        let selection = controller.take_for_translation().unwrap();
        let generation = controller.begin_mouse_up();
        controller.replace_selection(generation, "new".into(), Anchor { x: 1, y: 1 });

        assert!(!controller.restore_after_translation_failure(selection));
        assert_eq!(controller.take_for_translation().map(|selection| selection.text), Some("new".into()));
    }

    #[test]
    fn selection_at_12000_characters_is_shown() {
        let mut controller = SelectionController::default();
        let text = "x".repeat(12_000);
        let generation = controller.begin_mouse_up();

        let change =
            controller.replace_selection(generation, text.clone(), Anchor { x: 1, y: 2 });

        assert_eq!(change, StateChange::Show(Selection {
            text,
            anchor: Anchor { x: 1, y: 2 },
            generation: 1,
        }));
    }

    #[test]
    fn selection_over_12000_characters_is_unchanged_and_keeps_visible_text() {
        let mut controller = visible_controller("valid selection");
        let over_limit_text = "x".repeat(12_001);
        let generation = controller.begin_mouse_up();

        let change =
            controller.replace_selection(generation, over_limit_text, Anchor { x: 1, y: 2 });

        assert_eq!(change, StateChange::Unchanged);
        assert_eq!(controller.take_for_translation().map(|selection| selection.text), Some("valid selection".into()));
    }

    #[test]
    fn stale_selection_cannot_replace_a_newer_selection() {
        let mut controller = SelectionController::default();
        let stale_generation = controller.begin_mouse_up();
        let current_generation = controller.begin_mouse_up();

        assert!(matches!(
            controller.replace_selection(
                current_generation,
                "current".into(),
                Anchor { x: 20, y: 30 },
            ),
            StateChange::Show(_)
        ));
        assert_eq!(
            controller.replace_selection(
                stale_generation,
                "stale".into(),
                Anchor { x: 1, y: 2 },
            ),
            StateChange::Unchanged
        );
        assert_eq!(controller.take_for_translation().map(|selection| selection.text), Some("current".into()));
    }

    #[test]
    fn stale_empty_capture_cannot_hide_a_newer_selection() {
        let mut controller = visible_controller("original");
        let stale_generation = controller.begin_mouse_up();
        let current_generation = controller.begin_mouse_up();
        controller.replace_selection(
            current_generation,
            "current".into(),
            Anchor { x: 20, y: 30 },
        );

        assert_eq!(
            controller.clear_after_plain_click(stale_generation, false),
            StateChange::Unchanged
        );
        assert_eq!(controller.take_for_translation().map(|selection| selection.text), Some("current".into()));
    }

    #[test]
    fn float_click_generation_prevents_an_older_capture_from_reinserting_consumed_text() {
        let mut controller = visible_controller("translate me");
        let stale_generation = controller.begin_mouse_up();
        let _float_click_generation = controller.begin_mouse_up();

        assert_eq!(
            controller.take_for_translation().map(|selection| selection.text),
            Some("translate me".into())
        );
        assert_eq!(
            controller.replace_selection(
                stale_generation,
                "stale".into(),
                Anchor { x: 1, y: 2 },
            ),
            StateChange::Unchanged
        );
        assert_eq!(controller.take_for_translation(), None);
    }
}
