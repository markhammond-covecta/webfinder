// webfinder-helper - reads the real Finder sidebar favourites.
//
// Uses the (deprecated but still functional) LSSharedFileList API, which goes
// through a system service and so works WITHOUT Full Disk Access - unlike
// reading the protected ~/Library/.../com.apple.sharedfilelist directory.
//
// Usage:  webfinder-helper sidebar   ->  prints JSON [{ "name", "path" }, ...]

import Foundation
import CoreServices

func sidebar() {
    let ref = LSSharedFileListCreate(nil, kLSSharedFileListFavoriteItems.takeRetainedValue(), nil)
    guard let list = ref?.takeRetainedValue() else { print("[]"); return }
    var seed: UInt32 = 0
    guard let snapU = LSSharedFileListCopySnapshot(list, &seed) else { print("[]"); return }
    let snap = snapU.takeRetainedValue() as? [LSSharedFileListItem] ?? []

    var out: [[String: String]] = []
    for item in snap {
        var err: Unmanaged<CFError>?
        guard let urlU = LSSharedFileListItemCopyResolvedURL(item, 0, &err) else { continue }
        let url = urlU.takeRetainedValue() as URL
        guard url.isFileURL else { continue }              // skip AirDrop/Network etc.
        var name = LSSharedFileListItemCopyDisplayName(item).takeRetainedValue() as String
        if name.isEmpty {
            name = url.path == "/" ? "Macintosh HD"
                 : (url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent)
        }
        out.append(["name": name, "path": url.path])
    }
    if let data = try? JSONSerialization.data(withJSONObject: out),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    } else { print("[]") }
}

let cmd = CommandLine.arguments.dropFirst().first ?? "sidebar"
switch cmd {
case "sidebar": sidebar()
default: print("[]")
}
