//! Colours shared by the renderer (and mirrored by the web HUD).
pub const Rgb = struct { r: u8, g: u8, b: u8 };

/// Car colour index 0..7, same values as the web HUD's palette.
pub const CAR_RGB = [8]Rgb{
    .{ .r = 0xff, .g = 0x2b, .b = 0xd6 }, // 0 hot magenta
    .{ .r = 0x00, .g = 0xe5, .b = 0xff }, // 1 electric cyan
    .{ .r = 0xff, .g = 0xd4, .b = 0x00 }, // 2 taxi yellow
    .{ .r = 0x39, .g = 0xff, .b = 0x14 }, // 3 acid green
    .{ .r = 0xff, .g = 0x6a, .b = 0x00 }, // 4 blaze orange
    .{ .r = 0x8a, .g = 0x5c, .b = 0xff }, // 5 ultraviolet
    .{ .r = 0xff, .g = 0xff, .b = 0xff }, // 6 pearl white
    .{ .r = 0xff, .g = 0x33, .b = 0x55 }, // 7 signal red
};

pub fn car(colour: u8) Rgb {
    return CAR_RGB[colour & 7];
}
