//! Element data for the supported range H-Ar (Z = 1..=18).
//!
//! The scope is deliberately limited to the first three periods: everything
//! here is treated with an all-electron description, so heavy elements that
//! would need pseudopotentials or relativistic corrections are out of range.

/// Highest atomic number the engine accepts.
pub const MAX_Z: u8 = 18;

/// Static per-element data used by both the engine and the UI.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Element {
    /// Atomic number.
    pub z: u8,
    /// IUPAC symbol, e.g. `"C"`.
    pub symbol: &'static str,
    /// Standard atomic weight in unified atomic mass units.
    pub mass: f64,
    /// Covalent radius in Angstrom (Cordero et al. 2008). Used for bond detection.
    pub covalent_radius: f64,
    /// Van der Waals radius in Angstrom (Bondi 1964). Used for sphere sizing.
    pub vdw_radius: f64,
    /// CPK/Jmol display colour as `0xRRGGBB`.
    pub color: u32,
}

const fn e(
    z: u8,
    symbol: &'static str,
    mass: f64,
    covalent_radius: f64,
    vdw_radius: f64,
    color: u32,
) -> Element {
    Element { z, symbol, mass, covalent_radius, vdw_radius, color }
}

/// Table indexed by `z - 1`.
static ELEMENTS: [Element; MAX_Z as usize] = [
    e(1, "H", 1.008, 0.31, 1.20, 0xFFFFFF),
    e(2, "He", 4.002_602, 0.28, 1.40, 0xD9FFFF),
    e(3, "Li", 6.94, 1.28, 1.82, 0xCC80FF),
    e(4, "Be", 9.012_183, 0.96, 1.53, 0xC2FF00),
    e(5, "B", 10.81, 0.84, 1.92, 0xFFB5B5),
    e(6, "C", 12.011, 0.76, 1.70, 0x909090),
    e(7, "N", 14.007, 0.71, 1.55, 0x3050F8),
    e(8, "O", 15.999, 0.66, 1.52, 0xFF0D0D),
    e(9, "F", 18.998_403_16, 0.57, 1.47, 0x90E050),
    e(10, "Ne", 20.1797, 0.58, 1.54, 0xB3E3F5),
    e(11, "Na", 22.989_769_28, 1.66, 2.27, 0xAB5CF2),
    e(12, "Mg", 24.305, 1.41, 1.73, 0x8AFF00),
    e(13, "Al", 26.981_538_4, 1.21, 1.84, 0xBFA6A6),
    e(14, "Si", 28.085, 1.11, 2.10, 0xF0C8A0),
    e(15, "P", 30.973_761_998, 1.07, 1.80, 0xFF8000),
    e(16, "S", 32.06, 1.05, 1.80, 0xFFFF30),
    e(17, "Cl", 35.45, 1.02, 1.75, 0x1FF01F),
    e(18, "Ar", 39.95, 1.06, 1.88, 0x80D1E3),
];

/// Returns the element data for `z`, or `None` if `z` is outside H-Ar.
pub fn get(z: u8) -> Option<&'static Element> {
    if z == 0 || z > MAX_Z {
        return None;
    }
    Some(&ELEMENTS[(z - 1) as usize])
}

/// Every supported element, in order of atomic number.
pub fn all() -> &'static [Element] {
    &ELEMENTS
}

/// Looks up an element by symbol. The comparison is case sensitive, matching
/// IUPAC capitalisation (`"Cl"`, not `"CL"`).
pub fn by_symbol(symbol: &str) -> Option<&'static Element> {
    ELEMENTS.iter().find(|el| el.symbol == symbol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_indexed_by_atomic_number() {
        for (i, el) in ELEMENTS.iter().enumerate() {
            assert_eq!(el.z as usize, i + 1);
        }
    }

    #[test]
    fn lookups_agree() {
        assert_eq!(get(6).unwrap().symbol, "C");
        assert_eq!(by_symbol("Cl").unwrap().z, 17);
        assert!(get(0).is_none());
        assert!(get(19).is_none());
        assert!(by_symbol("Fe").is_none());
    }
}
