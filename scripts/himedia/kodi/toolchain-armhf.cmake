# CMake toolchain: Debian trixie container (any host arch) -> ARMv7 hard-float NEON (HiMedia Q10 Pro, Hi3798CV200 = 4x Cortex-A7).
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(CMAKE_C_COMPILER   arm-linux-gnueabihf-gcc)
set(CMAKE_CXX_COMPILER arm-linux-gnueabihf-g++)
set(CMAKE_AR           arm-linux-gnueabihf-ar)
set(CMAKE_STRIP        arm-linux-gnueabihf-strip)
set(CMAKE_LIBRARY_ARCHITECTURE arm-linux-gnueabihf)
set(_arm "-march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard")
# Debian's patch 0003 (differentiate-from-vanilla) needs these two defines; DEB_VERSION shows in Settings > System > About
set(_deb "-D_XBMC -DDEB_VERSION=\\\"2:21.2+dfsg-4+q10v4l2req1\\\"")
set(CMAKE_C_FLAGS_INIT   "${_arm} ${_deb}")
set(CMAKE_CXX_FLAGS_INIT "${_arm} ${_deb}")
# rpath: our FFmpeg first, then Kodi's own lib dir. RUNPATH is per-object, so every linked object gets it.
foreach(_k EXE SHARED MODULE)
  set(CMAKE_${_k}_LINKER_FLAGS_INIT "-Wl,-rpath,/opt/ffmpeg-v4l2req/lib:/opt/kodi-v4l2req/lib -latomic")
endforeach()
set(ENV{PKG_CONFIG_LIBDIR} "/opt/ffmpeg-v4l2req/lib/pkgconfig:/usr/lib/arm-linux-gnueabihf/pkgconfig:/usr/share/pkgconfig")
set(ENV{PKG_CONFIG_PATH} "")
# target libs/headers from armhf multiarch + our FFmpeg; host programs (python, swig, java, flatc) from the build arch
set(CMAKE_FIND_ROOT_PATH /usr /opt/ffmpeg-v4l2req)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
