cmake_minimum_required(VERSION 3.21)
project(vfgpipe CXX)

# Root of the extracted VFX SDK Core (the folder containing bin/, nvvfx/, features/).
set(VFXSDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../sdk/core/VideoFX" CACHE PATH "VFX SDK root")
get_filename_component(VFXSDK_ROOT "${VFXSDK_ROOT}" ABSOLUTE)

foreach(p "${VFXSDK_ROOT}/nvvfx/include/nvVideoEffects.h")
  if(NOT EXISTS "${p}")
    message(FATAL_ERROR "Missing ${p}. Set -DVFXSDK_ROOT to the VFX SDK Core folder.")
  endif()
endforeach()

add_executable(vfgpipe
  main.cpp
  # The SDK ships these as source "proxies": they LoadLibrary the real DLLs at runtime.
  ${VFXSDK_ROOT}/nvvfx/src/nvCVImageProxy.cpp
  ${VFXSDK_ROOT}/nvvfx/src/nvVideoEffectsProxy.cpp)

target_include_directories(vfgpipe PRIVATE ${VFXSDK_ROOT}/nvvfx/include ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(vfgpipe PRIVATE cxx_std_17)
target_compile_definitions(vfgpipe PRIVATE _CRT_SECURE_NO_WARNINGS)

if(MSVC)
  # Static CRT: no VC++ redistributable needed next to the exe.
  set_property(TARGET vfgpipe PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  target_compile_options(vfgpipe PRIVATE /W3 /utf-8)
endif()

set_target_properties(vfgpipe PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/../bin")
