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
}

impl SelectionController {
    pub fn replace_selection(&mut self, text: String, anchor: Anchor) -> StateChange {
        if text.chars().count() > MAX_SELECTION_CHARACTERS {
            return StateChange::Unchanged;
        }

        self.next_generation += 1;
        let selection = Selection {
            text,
            anchor,
            generation: self.next_generation,
        };
        self.current = Some(selection.clone());
        StateChange::Show(selection)
    }

    pub fn clear_after_plain_click(&mut self, clicked_float: bool) -> StateChange {
        if clicked_float || self.current.is_none() {
            StateChange::Unchanged
        } else {
            self.current = None;
            StateChange::Hide
        }
    }

    pub fn take_for_translation(&mut self) -> Option<String> {
        self.current.take().map(|selection| selection.text)
    }
}

#[cfg(test)]
fn visible_controller(text: &str) -> SelectionController {
    let mut controller = SelectionController::default();
    controller.replace_selection(text.to_owned(), Anchor { x: 0, y: 0 });
    controller
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_selection_replaces_visible_selection() {
        let mut controller = SelectionController::default();
        controller.replace_selection("first".into(), Anchor { x: 1, y: 1 });
        let change = controller.replace_selection("second".into(), Anchor { x: 2, y: 2 });

        assert_eq!(change, StateChange::Show(Selection {
            text: "second".into(), anchor: Anchor { x: 2, y: 2 }, generation: 2,
        }));
    }

    #[test]
    fn plain_click_hides_visible_float_but_clicking_float_does_not() {
        let mut controller = visible_controller("selected");
        assert_eq!(controller.clear_after_plain_click(false), StateChange::Hide);

        let mut controller = visible_controller("selected");
        assert_eq!(controller.clear_after_plain_click(true), StateChange::Unchanged);
    }

    #[test]
    fn float_click_returns_exact_saved_text_once() {
        let mut controller = visible_controller("selected");
        assert_eq!(controller.take_for_translation(), Some("selected".into()));
        assert_eq!(controller.take_for_translation(), None);
    }

    #[test]
    fn selection_at_12000_characters_is_shown() {
        let mut controller = SelectionController::default();
        let text = "x".repeat(12_000);

        let change = controller.replace_selection(text.clone(), Anchor { x: 1, y: 2 });

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

        let change = controller.replace_selection(over_limit_text, Anchor { x: 1, y: 2 });

        assert_eq!(change, StateChange::Unchanged);
        assert_eq!(controller.take_for_translation(), Some("valid selection".into()));
    }
}
